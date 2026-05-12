export type ErrorCode = "invalid-code" | "session-full" | "not-host" | "not-client" | "no-pending-request" | "not-paired" | "bad-message" | "session-ended" | "invalid-token";
export type ClientToServer = {
  type: "host:create";
  hostName?: string;
} | {
  type: "host:claim";
  token: string;
  hostName?: string;
} | {
  type: "host:approve";
  requestId: string;
} | {
  type: "host:reject";
  requestId: string;
  reason?: string;
} | {
  type: "host:end";
} | {
  type: "host:setControl";
  allowed: boolean;
} | {
  type: "client:join";
  code: string;
  clientName?: string;
} | {
  type: "client:claim";
  token: string;
  clientName?: string;
} | {
  type: "client:cancel";
} | {
  type: "signal";
  data: unknown;
};
export type ServerToClient = {
  type: "session:created";
  code: string;
} | {
  type: "request:incoming";
  requestId: string;
  clientName: string;
  at: number;
} | {
  type: "request:approved";
} | {
  type: "request:rejected";
  reason: string;
} | {
  type: "peer:ready";
  role: "host" | "client";
  allowControl: boolean;
  /** Session code (== LiveKit room name). Always present so both sides can
   *  join voice without the client having to know its own code up-front,
   *  which is the autopair / embed case. */
  code: string;
} | {
  type: "peer:left";
  reason: string;
} | {
  type: "control:changed";
  allowed: boolean;
} | {
  type: "signal";
  data: unknown;
} | {
  type: "error";
  code: ErrorCode;
  message: string;
};
