// Matrix tests cover the optional hold that joins a captionless attachment with its text.
import type { ChannelIngressMonitorLifecycle } from "openclaw/plugin-sdk/channel-outbound";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installMatrixMonitorTestRuntime } from "../../test-runtime.js";
import {
  createMatrixHandlerTestHarness,
  createMatrixIngressLifecycle,
  createMatrixRoomMessageEvent,
  createMatrixTextMessageEvent,
} from "./handler.test-helpers.js";
import { createMatrixMediaHold } from "./media-hold.js";
import type { MatrixRawEvent, RoomMessageEventContent } from "./types.js";

const { downloadMatrixMediaMock } = vi.hoisted(() => ({
  downloadMatrixMediaMock: vi.fn(),
}));

vi.mock("./media.js", async () => {
  const actual = await vi.importActual<typeof import("./media.js")>("./media.js");
  return {
    ...actual,
    downloadMatrixMedia: (...args: unknown[]) => downloadMatrixMediaMock(...args),
  };
});

const ROOM = "!dm:example.org";
const USER = "@user:example.org";
const BOT = "@bot:example.org";
const HOLD_MS = 20_000;

function imageEvent(
  eventId: string,
  extra: Partial<RoomMessageEventContent> & Record<string, unknown> = {},
  sender = USER,
): MatrixRawEvent {
  return createMatrixRoomMessageEvent({
    eventId,
    sender,
    content: {
      msgtype: "m.image",
      body: "photo.png",
      url: "mxc://example.org/photo",
      info: { mimetype: "image/png", size: 123 },
      ...extra,
    },
  });
}

function textEvent(eventId: string, body: string, sender = USER, threadRootId?: string) {
  return createMatrixTextMessageEvent({
    eventId,
    sender,
    body,
    ...(threadRootId ? { relatesTo: { rel_type: "m.thread", event_id: threadRootId } } : {}),
  });
}

type Lifecycle = ReturnType<typeof createMatrixIngressLifecycle> & {
  onCancelled?: ReturnType<typeof vi.fn>;
};

function claim(extra: Partial<Lifecycle> = {}): Lifecycle {
  return { ...createMatrixIngressLifecycle(), onCancelled: vi.fn(async () => {}), ...extra };
}

type DispatchCall = {
  event: MatrixRawEvent;
  lifecycle: ChannelIngressMonitorLifecycle;
};

function createHold(
  params: {
    isControlCommand?: (roomId: string, event: MatrixRawEvent) => Promise<boolean>;
    /** What the handler does with each dispatched event (default: adopt the turn). */
    onDispatch?: (call: DispatchCall) => Promise<void>;
  } = {},
) {
  const calls: DispatchCall[] = [];
  const dispatch = vi.fn(
    async (_roomId: string, event: MatrixRawEvent, lifecycle: ChannelIngressMonitorLifecycle) => {
      const call = { event, lifecycle };
      calls.push(call);
      await (params.onDispatch ?? (async (dispatched) => await dispatched.lifecycle.onAdopted()))(
        call,
      );
    },
  );
  const hold = createMatrixMediaHold({
    holdMs: HOLD_MS,
    selfUserId: BOT,
    dispatch,
    isControlCommand: params.isControlCommand ?? (async () => false),
    logVerboseMessage: () => {},
  });
  return { hold, dispatch, calls, ids: () => calls.map((call) => call.event.event_id) };
}

describe("createMatrixMediaHold", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("joins a captionless attachment with the sender's next text under both claims", async () => {
    const { hold, calls } = createHold();
    const media = claim();
    const text = claim();

    await expect(hold.onRoomMessage(ROOM, imageEvent("$image"), media)).resolves.toEqual({
      kind: "deferred",
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toHaveLength(0);
    await hold.onRoomMessage(ROOM, textEvent("$text", "what is this?"), text);

    expect(calls).toHaveLength(1);
    const [{ event }] = calls as [DispatchCall];
    expect(event.event_id).toBe("$text");
    expect(event.content).toMatchObject({
      msgtype: "m.image",
      body: "what is this?",
      filename: "photo.png",
      url: "mxc://example.org/photo",
      info: { mimetype: "image/png", size: 123 },
    });
    expect(media.onAdopted).toHaveBeenCalledTimes(1);
    expect(text.onAdopted).toHaveBeenCalledTimes(1);
  });

  it("dispatches the attachment alone under its own claim when no text arrives", async () => {
    const { hold, calls, ids } = createHold();
    const media = claim();

    await hold.onRoomMessage(ROOM, imageEvent("$image"), media);
    await vi.advanceTimersByTimeAsync(HOLD_MS - 1);
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(ids()).toEqual(["$image"]);
    expect(calls[0]?.event.content.body).toBe("photo.png");
    expect(media.onAdopted).toHaveBeenCalledTimes(1);

    await hold.onRoomMessage(ROOM, textEvent("$text", "late text"), claim());
    expect(ids()).toEqual(["$image", "$text"]);
    expect(calls[1]?.event.content.msgtype).toBe("m.text");
  });

  it("keeps the held claim alive with deferred heartbeats while it waits", async () => {
    const { hold } = createHold();
    const media = claim({ onDeferredHeartbeat: vi.fn(), deferredHeartbeatIntervalMs: 4_000 });

    await hold.onRoomMessage(ROOM, imageEvent("$image"), media);
    await vi.advanceTimersByTimeAsync(9_000);
    expect(media.onDeferredHeartbeat).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(HOLD_MS);
    const beats = media.onDeferredHeartbeat.mock.calls.length;
    await vi.advanceTimersByTimeAsync(HOLD_MS);
    expect(media.onDeferredHeartbeat).toHaveBeenCalledTimes(beats);
  });

  it("dispatches a held attachment first when a second attachment arrives", async () => {
    const { hold, ids } = createHold();

    await hold.onRoomMessage(ROOM, imageEvent("$image1"), claim());
    await hold.onRoomMessage(ROOM, imageEvent("$image2"), claim());
    await vi.advanceTimersByTimeAsync(0);
    expect(ids()).toEqual(["$image1"]);

    await hold.onRoomMessage(ROOM, textEvent("$text", "compare these"), claim());
    expect(ids()).toEqual(["$image1", "$text"]);
    expect(ids()).not.toContain("$image2");
  });

  it("admits the held attachment before another sender's message starts", async () => {
    const order: string[] = [];
    const { hold, calls, ids } = createHold({
      onDispatch: async ({ event, lifecycle }) => {
        order.push(`start:${event.event_id}`);
        await lifecycle.onAdopted();
        order.push(`adopted:${event.event_id}`);
      },
    });

    await hold.onRoomMessage(ROOM, imageEvent("$image"), claim());
    await hold.onRoomMessage(ROOM, textEvent("$other", "hi", "@other:example.org"), claim());

    expect(ids()).toEqual(["$image", "$other"]);
    expect(order).toEqual(["start:$image", "adopted:$image", "start:$other", "adopted:$other"]);
    expect(calls[1]?.event.content.msgtype).toBe("m.text");
  });

  it("never folds a control command into an attachment", async () => {
    const isControlCommand = vi.fn(
      async (_roomId: string, event: MatrixRawEvent) =>
        (event.content as RoomMessageEventContent).body === "OpenClaw: /stop",
    );
    const { hold, calls, ids } = createHold({ isControlCommand });

    await hold.onRoomMessage(ROOM, imageEvent("$image"), claim());
    await hold.onRoomMessage(ROOM, textEvent("$stop", "OpenClaw: /stop"), claim());

    expect(ids()).toEqual(["$image", "$stop"]);
    expect(calls[1]?.event.content).toMatchObject({ msgtype: "m.text", body: "OpenClaw: /stop" });
    expect(isControlCommand).toHaveBeenCalledWith(
      ROOM,
      expect.objectContaining({ event_id: "$stop" }),
    );
  });

  it("releases a held attachment before a poll or location from the same conversation", async () => {
    const { hold, ids } = createHold();

    await hold.onRoomMessage(ROOM, imageEvent("$image"), claim());
    await hold.onRoomMessage(
      ROOM,
      {
        type: "org.matrix.msc3381.poll.start",
        sender: USER,
        event_id: "$poll",
        origin_server_ts: Date.now(),
        content: { "org.matrix.msc3381.poll.start": { question: { body: "Which?" } } },
      } as MatrixRawEvent,
      claim(),
    );

    expect(ids()).toEqual(["$image", "$poll"]);
  });

  it("only joins text from the same thread", async () => {
    const { hold, ids } = createHold();

    await hold.onRoomMessage(ROOM, imageEvent("$image"), claim());
    await hold.onRoomMessage(ROOM, textEvent("$threaded", "in a thread", USER, "$root"), claim());
    expect(ids()).toEqual(["$threaded"]);

    await vi.advanceTimersByTimeAsync(HOLD_MS);
    expect(ids()).toEqual(["$threaded", "$image"]);
  });

  it("does not hold captioned attachments, voice messages or the bot's own events", async () => {
    const { hold, ids } = createHold();

    await hold.onRoomMessage(
      ROOM,
      imageEvent("$captioned", { body: "look at this", filename: "photo.png" }),
      claim(),
    );
    await hold.onRoomMessage(
      ROOM,
      createMatrixRoomMessageEvent({
        eventId: "$voice",
        sender: USER,
        content: {
          msgtype: "m.audio",
          body: "voice.ogg",
          url: "mxc://example.org/voice",
          "org.matrix.msc3245.voice": {},
        },
      }),
      claim(),
    );
    await hold.onRoomMessage(ROOM, imageEvent("$held"), claim());
    await hold.onRoomMessage(ROOM, textEvent("$own", "my reply", BOT), claim());

    expect(ids()).toEqual(["$captioned", "$voice", "$own"]);
  });

  it("reopens held claims instead of starting turns when the monitor closes", async () => {
    const { hold, calls } = createHold();
    const media = claim();

    await hold.onRoomMessage(ROOM, imageEvent("$image"), media);
    hold.close();
    await vi.advanceTimersByTimeAsync(HOLD_MS);

    expect(calls).toHaveLength(0);
    expect(media.onCancelled).toHaveBeenCalledTimes(1);
    expect(media.onAdopted).not.toHaveBeenCalled();
    await hold.onRoomMessage(ROOM, imageEvent("$after"), claim());
    expect(calls.map((call) => call.event.event_id)).toEqual(["$after"]);
  });

  it("drops a held attachment whose claim the drain aborted", async () => {
    const { hold, calls } = createHold();
    const controller = new AbortController();
    const media = claim({ abortSignal: controller.signal });

    await hold.onRoomMessage(ROOM, imageEvent("$image"), media);
    controller.abort(new Error("stopped"));
    await vi.advanceTimersByTimeAsync(HOLD_MS);

    expect(calls).toHaveLength(0);
    expect(media.onCancelled).not.toHaveBeenCalled();
    expect(media.onAdopted).not.toHaveBeenCalled();
  });

  it("abandons both claims when the merged turn fails", async () => {
    const { hold } = createHold({
      onDispatch: async () => {
        throw new Error("handler failed");
      },
    });
    const media = claim({ onFailed: vi.fn(async () => {}) });
    const text = claim({ onFailed: vi.fn(async () => {}) });

    await hold.onRoomMessage(ROOM, imageEvent("$image"), media);
    await hold.onRoomMessage(ROOM, textEvent("$text", "summarize"), text);

    expect(media.onFailed).toHaveBeenCalledTimes(1);
    expect(text.onFailed).toHaveBeenCalledTimes(1);
    expect(media.onAdopted).not.toHaveBeenCalled();
  });
});

describe("Matrix media hold with the room message handler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    installMatrixMonitorTestRuntime();
    downloadMatrixMediaMock.mockReset();
    downloadMatrixMediaMock.mockResolvedValue({
      path: "/tmp/inbound/photo.png",
      contentType: "image/png",
      placeholder: "[matrix image attachment]",
    });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function createHarness() {
    const harness = createMatrixHandlerTestHarness({});
    const contexts = () =>
      (
        harness.recordInboundSession as unknown as {
          mock: { calls: [{ ctx: Record<string, unknown> }][] };
        }
      ).mock.calls.map(([payload]) => payload.ctx);
    return { ...harness, contexts };
  }

  it("answers an attachment and the text sent after it in one turn", async () => {
    const { handler, contexts } = createHarness();
    const hold = createMatrixMediaHold({
      holdMs: HOLD_MS,
      selfUserId: BOT,
      dispatch: handler,
      isControlCommand: async () => false,
      logVerboseMessage: () => {},
    });
    const media = claim();
    const text = claim();

    await hold.onRoomMessage(ROOM, imageEvent("$image"), media);
    await vi.advanceTimersByTimeAsync(3_000);
    await hold.onRoomMessage(ROOM, textEvent("$text", "summarize this"), text);

    const turns = contexts();
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      RawBody: "summarize this",
      MediaPath: "/tmp/inbound/photo.png",
      MessageSid: "$text",
    });
    expect(media.onAdopted).toHaveBeenCalledTimes(1);
    expect(text.onAdopted).toHaveBeenCalledTimes(1);
  });

  it("keeps two turns without the hold", async () => {
    const { handler, contexts } = createHarness();

    await handler(ROOM, imageEvent("$image"));
    await handler(ROOM, textEvent("$text", "summarize this"));

    const turns = contexts();
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({ MediaPath: "/tmp/inbound/photo.png", MessageSid: "$image" });
    expect(turns[1]).toMatchObject({ RawBody: "summarize this", MessageSid: "$text" });
    expect(turns[1]?.MediaPath).toBeUndefined();
  });
});
