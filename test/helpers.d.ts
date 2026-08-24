import type { BusMessage } from '../src/plugins/agent-bus/bus.js';
import type { RoomMessage } from '../src/appserver/bus-gateway.js';
import type { TaskBoardDeps } from '../src/appserver/task-board.js';
import type { DecisionBoardDeps } from '../src/appserver/decision-board.js';
export interface TestRegistry {
    url: string;
    close: () => Promise<void>;
}
/** Registry on an ephemeral port; close() awaited in test teardown. */
export declare function bootRegistry(): Promise<TestRegistry>;
export declare function postJson(url: string, path: string, body: unknown): Promise<{
    status: number;
    body: unknown;
}>;
export declare function getJson(url: string, path: string): Promise<unknown>;
export declare function pollMessages(url: string, agentId: string): Promise<BusMessage[]>;
/** Register + join in one call. */
export declare function joinChannel(url: string, channel: string, agentId: string): Promise<void>;
export declare function makeDb(): Database;
export interface RecordedCall {
    target: string;
    payload: unknown;
}
/** TaskBoard deps with recording fakes; override requestAgent to script replies. */
export declare function makeTaskDeps(overrides?: Partial<TaskBoardDeps>): TaskBoardDeps & {
    messages: string[];
    requests: RecordedCall[];
};
/** DecisionBoard deps with recording fakes. */
export declare function makeDecisionDeps(overrides?: Partial<DecisionBoardDeps>): DecisionBoardDeps & {
    messages: string[];
    requests: RecordedCall[];
};
export declare function roomMsg(room: string, from: string, text: string, kind?: RoomMessage['kind']): RoomMessage;
/** Poll a predicate until true or timeout (ms). Throws on timeout. */
export declare function waitFor(pred: () => boolean | Promise<boolean>, timeoutMs?: number, stepMs?: number): Promise<void>;
