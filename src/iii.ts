// Single import surface for the iii SDK. The 0.24 client dropped the
// `ISdk`/`ApiRequest` type exports that every module used, and the HTTP
// trigger handler shape moved out of the package. Keeping one local module
// means a future SDK bump touches this file, not 60 call sites.
import type { IIIClient } from "iii-sdk";

export { TriggerAction, registerWorker } from "iii-sdk";
export type {
  IIIClient,
  IIIConnectionState,
  InitOptions,
  JsonValue,
  MiddlewareFunctionInput,
  StreamRequest,
  StreamResponse,
} from "iii-sdk";

/** Client surface every register... function receives. */
export type ISdk = IIIClient;

/** HTTP request as delivered to a function bound to an `http` trigger. */
export interface ApiRequest<T = Record<string, unknown>> {
  body: T;
  query_params: Record<string, string | string[] | undefined>;
  headers: Record<string, string | string[] | undefined>;
  path_params?: Record<string, string>;
  method?: string;
}
