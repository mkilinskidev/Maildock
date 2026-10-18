import { toast, type ExternalToast } from "sonner";

export const DEFAULT_TOAST_DURATION = 5000;

type NotifyOptions = Pick<
  ExternalToast,
  "id" | "duration" | "onDismiss" | "onAutoClose"
>;

/**
 * Single entry point for transient UI notifications. Call from any client
 * code, e.g. `notify.success("Message flagged")`. Passing the same `id` again
 * updates the visible toast in place instead of stacking a new one.
 * `<AppToaster />` (mounted once in the root layout) renders them.
 */
export const notify = {
  info: (message: string, options?: NotifyOptions) =>
    toast(message, { duration: DEFAULT_TOAST_DURATION, ...options }),
  success: (message: string, options?: NotifyOptions) =>
    toast.success(message, { duration: DEFAULT_TOAST_DURATION, ...options }),
  warning: (message: string, options?: NotifyOptions) =>
    toast.warning(message, { duration: DEFAULT_TOAST_DURATION, ...options }),
  error: (message: string, options?: NotifyOptions) =>
    toast.error(message, { duration: DEFAULT_TOAST_DURATION, ...options }),
  /** Persistent progress toast; replace it later by reusing its `id`. */
  loading: (message: string, options?: NotifyOptions) =>
    toast.loading(message, { duration: Infinity, ...options }),
  dismiss: (id?: string | number) => toast.dismiss(id),
};
