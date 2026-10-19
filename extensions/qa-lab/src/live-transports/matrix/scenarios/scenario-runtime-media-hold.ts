// Matrix QA scenarios for channels.matrix.mediaHoldMs: a captionless attachment
// waits for the sender's next text and both are answered as one turn.
import type { MatrixQaObservedEvent } from "../substrate/events.js";
import {
  MATRIX_QA_DRIVER_DM_ROOM_KEY,
  resolveMatrixQaScenarioRoomId,
} from "./scenario-contract.js";
import {
  buildMatrixQaImageUnderstandingPrompt,
  createMatrixQaSplitColorImagePng,
  hasMatrixQaExpectedColorReply,
  MATRIX_QA_IMAGE_ATTACHMENT_FILENAME,
} from "./scenario-media-fixtures.js";
import { withMatrixQaIsolatedE2eeDriverRoom } from "./scenario-runtime-e2ee-room.js";
import {
  advanceMatrixQaActorCursor,
  assertNoSutReplyWindow,
  buildMatrixReplyArtifact,
  buildMatrixReplyDetails,
  isMatrixQaMessageLikeKind,
  primeMatrixQaDriverScenarioClient,
  resolveMatrixQaNoReplyWindowMs,
  truncateMatrixQaPreview,
  type MatrixQaScenarioContext,
} from "./scenario-runtime-shared.js";
import type { MatrixQaScenarioExecution } from "./scenario-types.js";

/** The hold configured by the media-hold scenario files (`matrixConfigOverrides.mediaHoldMs`). */
export const MATRIX_QA_MEDIA_HOLD_MS = 8_000;
/** The longer hold the restart scenario configures so a held attachment outlives the restart. */
export const MATRIX_QA_MEDIA_HOLD_RESTART_MS = 60_000;
export const MATRIX_QA_MEDIA_HOLD_ROOM_KEY = "media-hold";
const MOCK_REPLY_PREFIX = "Protocol note:";

function isSutMessage(event: MatrixQaObservedEvent, roomId: string, sutUserId: string) {
  return (
    event.roomId === roomId &&
    event.sender === sutUserId &&
    event.type === "m.room.message" &&
    isMatrixQaMessageLikeKind(event.kind)
  );
}

function describeRecentRoomEvents(context: MatrixQaScenarioContext, roomId: string) {
  return context.observedEvents
    .filter((event) => event.roomId === roomId)
    .slice(-8)
    .map((event) => ({
      body: truncateMatrixQaPreview(event.body),
      eventId: event.eventId,
      sender: event.sender,
      type: event.type,
    }));
}

async function sendCaptionlessImage(
  context: MatrixQaScenarioContext,
  client: Awaited<ReturnType<typeof primeMatrixQaDriverScenarioClient>>["client"],
  roomId: string,
  since: string,
) {
  const driverEventId = await client.sendMediaMessage({
    buffer: createMatrixQaSplitColorImagePng(),
    contentType: "image/png",
    fileName: MATRIX_QA_IMAGE_ATTACHMENT_FILENAME,
    kind: "image",
    roomId,
  });
  const attachmentEvent = await client.waitForRoomEvent({
    observedEvents: context.observedEvents,
    predicate: (event) =>
      event.roomId === roomId &&
      event.eventId === driverEventId &&
      event.sender === context.driverUserId &&
      event.attachment?.kind === "image" &&
      event.attachment.caption === undefined,
    roomId,
    since,
    timeoutMs: context.timeoutMs,
  });
  return { attachmentEvent, driverEventId };
}

async function assertNoSutReplyFor(
  context: MatrixQaScenarioContext,
  client: Awaited<ReturnType<typeof primeMatrixQaDriverScenarioClient>>["client"],
  roomId: string,
  since: string | undefined,
  windowMs: number,
  what: string,
) {
  const early = await client.waitForOptionalRoomEvent({
    observedEvents: context.observedEvents,
    predicate: (event) => isSutMessage(event, roomId, context.sutUserId),
    roomId,
    since,
    timeoutMs: windowMs,
  });
  if (early.matched) {
    throw new Error(
      `${what}: unexpected SUT reply ${early.event.eventId} within ${windowMs}ms; recent room events: ${JSON.stringify(describeRecentRoomEvents(context, roomId))}`,
    );
  }
}

/** Attachment, then the question a few seconds later: one answer that saw the image. */
export async function runMediaHoldAttachmentThenTextScenario(context: MatrixQaScenarioContext) {
  const roomId = resolveMatrixQaScenarioRoomId(context, MATRIX_QA_MEDIA_HOLD_ROOM_KEY);
  const { client, startSince } = await primeMatrixQaDriverScenarioClient(context);
  const { attachmentEvent, driverEventId: attachmentEventId } = await sendCaptionlessImage(
    context,
    client,
    roomId,
    startSince,
  );
  const quietMs = 2_500;
  await assertNoSutReplyFor(
    context,
    client,
    roomId,
    attachmentEvent.since,
    quietMs,
    "attachment-then-text",
  );
  const triggerBody = buildMatrixQaImageUnderstandingPrompt(context.sutUserId);
  const driverEventId = await client.sendTextMessage({
    body: triggerBody,
    mentionUserIds: [context.sutUserId],
    roomId,
  });
  const matched = await client.waitForRoomEvent({
    observedEvents: context.observedEvents,
    predicate: (event) =>
      isSutMessage(event, roomId, context.sutUserId) &&
      event.relatesTo === undefined &&
      hasMatrixQaExpectedColorReply(event.body),
    roomId,
    since: attachmentEvent.since,
    timeoutMs: context.timeoutMs,
  });
  const reply = buildMatrixReplyArtifact(matched.event);
  const { noReplyWindowMs } = await assertNoSutReplyWindow({
    actorId: "driver",
    client,
    context,
    roomId,
    since: matched.since,
    startSince,
    unexpectedMessage: "a second SUT reply after the joined attachment-and-text turn",
  });
  return {
    artifacts: {
      attachmentEventId,
      attachmentFilename: MATRIX_QA_IMAGE_ATTACHMENT_FILENAME,
      driverEventId,
      expectedNoReplyWindowMs: noReplyWindowMs,
      reply,
      roomId,
      triggerBody,
    },
    details: [
      `room id: ${roomId}`,
      `hold: ${MATRIX_QA_MEDIA_HOLD_MS}ms`,
      `captionless attachment event: ${attachmentEventId} (no SUT reply for ${quietMs}ms)`,
      `text event ${quietMs}ms later: ${driverEventId}`,
      ...buildMatrixReplyDetails("one reply that saw the image", reply),
      `no second reply for ${noReplyWindowMs}ms`,
    ].join("\n"),
  } satisfies MatrixQaScenarioExecution;
}

/** An attachment that gets no text is answered on its own once the hold ends. */
export async function runMediaHoldStandaloneTimeoutScenario(context: MatrixQaScenarioContext) {
  const roomId = resolveMatrixQaScenarioRoomId(context, MATRIX_QA_DRIVER_DM_ROOM_KEY);
  const { client, startSince } = await primeMatrixQaDriverScenarioClient(context);
  const { attachmentEvent, driverEventId } = await sendCaptionlessImage(
    context,
    client,
    roomId,
    startSince,
  );
  const quietMs = MATRIX_QA_MEDIA_HOLD_MS - 2_000;
  await assertNoSutReplyFor(
    context,
    client,
    roomId,
    attachmentEvent.since,
    quietMs,
    "standalone-timeout",
  );
  const matched = await client.waitForRoomEvent({
    observedEvents: context.observedEvents,
    predicate: (event) => isSutMessage(event, roomId, context.sutUserId),
    roomId,
    since: attachmentEvent.since,
    timeoutMs: context.timeoutMs,
  });
  advanceMatrixQaActorCursor({
    actorId: "driver",
    syncState: context.syncState,
    nextSince: matched.since,
    startSince,
  });
  const reply = buildMatrixReplyArtifact(matched.event);
  return {
    artifacts: {
      attachmentFilename: MATRIX_QA_IMAGE_ATTACHMENT_FILENAME,
      driverEventId,
      expectedNoReplyWindowMs: quietMs,
      reply,
      roomId,
    },
    details: [
      `room id: ${roomId}`,
      `hold: ${MATRIX_QA_MEDIA_HOLD_MS}ms`,
      `captionless attachment event: ${driverEventId}`,
      `no SUT reply for ${quietMs}ms, then`,
      ...buildMatrixReplyDetails("standalone reply after the hold", reply),
    ].join("\n"),
  } satisfies MatrixQaScenarioExecution;
}

/**
 * A control command sent while an attachment is held: the attachment is released
 * on its own (never folded into the command, never lost) and both are answered.
 * Reply order is not asserted: a command answers synchronously while the
 * attachment's turn goes through the model.
 */
export async function runMediaHoldCommandOrderingScenario(context: MatrixQaScenarioContext) {
  const roomId = resolveMatrixQaScenarioRoomId(context, MATRIX_QA_DRIVER_DM_ROOM_KEY);
  const { client, startSince } = await primeMatrixQaDriverScenarioClient(context);
  const { attachmentEvent, driverEventId: attachmentEventId } = await sendCaptionlessImage(
    context,
    client,
    roomId,
    startSince,
  );
  const driverEventId = await client.sendTextMessage({ body: "/status", roomId });
  const isModelReply = (event: MatrixQaObservedEvent) =>
    isSutMessage(event, roomId, context.sutUserId) &&
    (event.body ?? "").startsWith(MOCK_REPLY_PREFIX);
  const isCommandReply = (event: MatrixQaObservedEvent) =>
    isSutMessage(event, roomId, context.sutUserId) &&
    !(event.body ?? "").startsWith(MOCK_REPLY_PREFIX);
  const [modelReply, commandReply] = await Promise.all([
    client.waitForRoomEvent({
      observedEvents: context.observedEvents,
      predicate: isModelReply,
      roomId,
      since: attachmentEvent.since,
      timeoutMs: context.timeoutMs,
    }),
    client.waitForRoomEvent({
      observedEvents: context.observedEvents,
      predicate: isCommandReply,
      roomId,
      since: attachmentEvent.since,
      timeoutMs: context.timeoutMs,
    }),
  ]);
  advanceMatrixQaActorCursor({
    actorId: "driver",
    syncState: context.syncState,
    nextSince: modelReply.since,
    startSince,
  });
  const firstReply = buildMatrixReplyArtifact(modelReply.event);
  const secondReply = buildMatrixReplyArtifact(commandReply.event);
  const observedOrder = context.observedEvents
    .filter(
      (event) =>
        event.eventId === modelReply.event.eventId || event.eventId === commandReply.event.eventId,
    )
    .map((event) =>
      event.eventId === modelReply.event.eventId ? "attachment reply" : "/status reply",
    );
  return {
    artifacts: {
      attachmentEventId,
      attachmentFilename: MATRIX_QA_IMAGE_ATTACHMENT_FILENAME,
      driverEventId,
      firstReply,
      roomId,
      secondReply,
    },
    details: [
      `room id: ${roomId}`,
      `hold: ${MATRIX_QA_MEDIA_HOLD_MS}ms`,
      `captionless attachment event: ${attachmentEventId}`,
      `/status event right after it: ${driverEventId}`,
      ...buildMatrixReplyDetails(
        "model reply to the attachment (not folded into the command)",
        firstReply,
      ),
      ...buildMatrixReplyDetails("/status reply", secondReply),
      `observed reply order: ${[...new Set(observedOrder)].join(", ")}`,
    ].join("\n"),
  } satisfies MatrixQaScenarioExecution;
}

/** The gateway restarts while an attachment is held; the text sent afterwards still joins it. */
export async function runMediaHoldRestartRecoveryScenario(context: MatrixQaScenarioContext) {
  if (!context.restartGatewayAfterStateMutation) {
    throw new Error("Matrix media hold restart scenario requires hard gateway restart support");
  }
  const roomId = resolveMatrixQaScenarioRoomId(context, MATRIX_QA_DRIVER_DM_ROOM_KEY);
  const { client, startSince } = await primeMatrixQaDriverScenarioClient(context);
  const { attachmentEvent, driverEventId: attachmentEventId } = await sendCaptionlessImage(
    context,
    client,
    roomId,
    startSince,
  );
  await assertNoSutReplyFor(
    context,
    client,
    roomId,
    attachmentEvent.since,
    1_500,
    "restart-recovery (before restart)",
  );
  const restartStartedAt = Date.now();
  await context.restartGatewayAfterStateMutation(async () => undefined, {
    timeoutMs: context.timeoutMs,
    waitAccountId: context.sutAccountId ?? "sut",
  });
  const restartMs = Date.now() - restartStartedAt;
  const triggerBody = buildMatrixQaImageUnderstandingPrompt(context.sutUserId);
  const driverEventId = await client.sendTextMessage({
    body: triggerBody,
    mentionUserIds: [context.sutUserId],
    roomId,
  });
  const matched = await client.waitForRoomEvent({
    observedEvents: context.observedEvents,
    predicate: (event) =>
      isSutMessage(event, roomId, context.sutUserId) && hasMatrixQaExpectedColorReply(event.body),
    roomId,
    since: attachmentEvent.since,
    timeoutMs: context.timeoutMs,
  });
  const reply = buildMatrixReplyArtifact(matched.event);
  const { noReplyWindowMs } = await assertNoSutReplyWindow({
    actorId: "driver",
    client,
    context,
    roomId,
    since: matched.since,
    startSince,
    unexpectedMessage: "a second SUT reply after the post-restart joined turn",
  });
  return {
    artifacts: {
      attachmentEventId,
      attachmentFilename: MATRIX_QA_IMAGE_ATTACHMENT_FILENAME,
      driverEventId,
      expectedNoReplyWindowMs: noReplyWindowMs,
      reply,
      restartSignal: "hard-restart",
      roomId,
      triggerBody,
    },
    details: [
      `room id: ${roomId}`,
      `hold: ${MATRIX_QA_MEDIA_HOLD_RESTART_MS}ms`,
      `captionless attachment event: ${attachmentEventId} (no SUT reply before the restart)`,
      `gateway hard restart while held: ${restartMs}ms`,
      `text event after the restart: ${driverEventId}`,
      ...buildMatrixReplyDetails("one reply that saw the image", reply),
      `no second reply for ${noReplyWindowMs}ms`,
    ].join("\n"),
  } satisfies MatrixQaScenarioExecution;
}

/** The same attachment-then-text flow in an encrypted room. */
export async function runMatrixQaE2eeMediaHoldScenario(
  context: MatrixQaScenarioContext,
): Promise<MatrixQaScenarioExecution> {
  return await withMatrixQaIsolatedE2eeDriverRoom(
    context,
    "matrix-e2ee-media-hold",
    async ({ client, driverUserId, roomId, roomKey }) => {
      await client.prime();
      // Body equal to the file name is the captionless shape (MSC2530).
      const attachmentEventId = await client.sendImageMessage({
        body: MATRIX_QA_IMAGE_ATTACHMENT_FILENAME,
        buffer: createMatrixQaSplitColorImagePng(),
        contentType: "image/png",
        fileName: MATRIX_QA_IMAGE_ATTACHMENT_FILENAME,
        roomId,
      });
      const attachmentEvent = await client.waitForRoomEvent({
        predicate: (event) =>
          event.roomId === roomId &&
          event.eventId === attachmentEventId &&
          event.sender === driverUserId &&
          event.attachment?.kind === "image" &&
          event.attachment.caption === undefined,
        roomId,
        timeoutMs: context.timeoutMs,
      });
      const quietMs = 2_500;
      const early = await client.waitForOptionalRoomEvent({
        predicate: (event) => isSutMessage(event, roomId, context.sutUserId),
        roomId,
        timeoutMs: quietMs,
      });
      if (early.matched) {
        throw new Error(
          `e2ee media hold: unexpected SUT reply ${early.event.eventId} within ${quietMs}ms of the encrypted attachment`,
        );
      }
      const triggerBody = buildMatrixQaImageUnderstandingPrompt(context.sutUserId);
      const driverEventId = await client.sendTextMessage({
        body: triggerBody,
        mentionUserIds: [context.sutUserId],
        roomId,
      });
      const matched = await client.waitForRoomEvent({
        predicate: (event) =>
          isSutMessage(event, roomId, context.sutUserId) &&
          event.relatesTo === undefined &&
          hasMatrixQaExpectedColorReply(event.body),
        roomId,
        timeoutMs: context.timeoutMs,
      });
      const reply = buildMatrixReplyArtifact(matched.event);
      const noReplyWindowMs = resolveMatrixQaNoReplyWindowMs(context.timeoutMs);
      const second = await client.waitForOptionalRoomEvent({
        predicate: (event) =>
          isSutMessage(event, roomId, context.sutUserId) && event.eventId !== matched.event.eventId,
        roomId,
        timeoutMs: noReplyWindowMs,
      });
      if (second.matched) {
        throw new Error(
          `e2ee media hold: a second SUT reply ${second.event.eventId} followed the joined turn within ${noReplyWindowMs}ms`,
        );
      }
      return {
        artifacts: {
          attachmentEventId,
          attachmentFilename: MATRIX_QA_IMAGE_ATTACHMENT_FILENAME,
          driverEventId,
          driverUserId,
          expectedNoReplyWindowMs: noReplyWindowMs,
          reply,
          roomKey,
          roomId,
          triggerBody,
        },
        details: [
          `encrypted room key: ${roomKey}`,
          `encrypted room id: ${roomId}`,
          `hold: ${MATRIX_QA_MEDIA_HOLD_MS}ms`,
          `captionless encrypted attachment event: ${attachmentEventId} (no SUT reply for ${quietMs}ms; observed ${attachmentEvent.event.eventId})`,
          `text event ${quietMs}ms later: ${driverEventId}`,
          ...buildMatrixReplyDetails("one reply that saw the image", reply),
          `no second reply for ${noReplyWindowMs}ms`,
        ].join("\n"),
      };
    },
  );
}
