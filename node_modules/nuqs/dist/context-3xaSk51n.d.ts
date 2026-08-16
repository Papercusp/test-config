import { i as Options } from "./defs-BUTBdnWx.js";
import { Context, ProviderProps, ReactElement, ReactNode } from "react";
//#region src/adapters/lib/defs.d.ts
type AdapterOptions = Pick<Options, "history" | "scroll" | "shallow">;
/**
 * Optionally return a Promise that resolves when the router has fully applied
 * the update (eg: after navigation and route loaders settle). It is passed to
 * the user's startTransition, keeping its isPending flag true until settlement
 * on React 19. The Promise should not reject: rejections bypass nuqs and
 * surface through React's transition error handling.
 */
type UpdateUrlFunction = (search: URLSearchParams, options: Required<AdapterOptions>) => void | Promise<void>;
type UseAdapterHook = (watchKeys: string[]) => AdapterInterface;
type AdapterInterface = {
  searchParams: URLSearchParams;
  pathname?: string;
  updateUrl: UpdateUrlFunction;
  getSearchParamsSnapshot?: () => URLSearchParams;
  rateLimitFactor?: number;
  autoResetQueueOnUpdate?: boolean;
};
//#endregion
//#region src/adapters/lib/context.d.ts
type AdapterProps = {
  defaultOptions?: Partial<Pick<Options, "history" | "shallow" | "clearOnDefault" | "scroll" | "limitUrlUpdates">>;
  processUrlSearchParams?: (search: URLSearchParams) => URLSearchParams;
};
type AdapterContext = AdapterProps & {
  useAdapter: UseAdapterHook;
};
declare const context: Context<AdapterContext>;
declare global {
  interface Window {
    __NuqsAdapterContext?: typeof context;
  }
}
type AdapterProvider = (props: AdapterProps & {
  children: ReactNode;
}) => ReactElement<ProviderProps<AdapterContext>>;
/**
 * Create a custom adapter (context provider) for nuqs to work with your framework / router.
 *
 * Adapters are based on React Context,
 *
 * @param useAdapter
 * @returns
 */
declare function createAdapterProvider(useAdapter: UseAdapterHook): AdapterProvider;
//#endregion
export { AdapterInterface as a, UseAdapterHook as c, createAdapterProvider as i, AdapterProps as n, AdapterOptions as o, AdapterProvider as r, UpdateUrlFunction as s, AdapterContext as t };
//# sourceMappingURL=context-3xaSk51n.d.ts.map