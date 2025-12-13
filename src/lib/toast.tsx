import * as React from 'react';
import { toast as sonnerToast } from 'sonner';

type ToastId = string | number;

type ToastVariant = 'default' | 'success' | 'error' | 'warning' | 'info' | 'loading';

type ToastUpdateOptions = {
  id?: ToastId;
  duration?: number | typeof Infinity;
};

type ToastObjectInput = {
  title?: React.ReactNode;
  description?: React.ReactNode;
  variant?: 'default' | 'destructive' | ToastVariant;
  duration?: number | typeof Infinity;
};

type ToastTimerState = {
  duration: number;
  remaining: number;
  startedAt: number;
  timeoutId: ReturnType<typeof setTimeout> | null;
  paused: boolean;
};

const DEFAULT_DURATION_MS = 4000;

let toastIdSeq = 0;
function generateToastId(): ToastId {
  toastIdSeq = (toastIdSeq + 1) % Number.MAX_SAFE_INTEGER;
  return `t_${toastIdSeq}`;
}

const stateById = new Map<ToastId, ToastTimerState>();
const listenersById = new Map<ToastId, Set<() => void>>();

function getSnapshot(id: ToastId) {
  return stateById.get(id) ?? null;
}

function subscribe(id: ToastId, listener: () => void) {
  const listeners = listenersById.get(id) ?? new Set<() => void>();
  listeners.add(listener);
  listenersById.set(id, listeners);

  return () => {
    const current = listenersById.get(id);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) listenersById.delete(id);
  };
}

function emit(id: ToastId) {
  const listeners = listenersById.get(id);
  if (!listeners) return;
  listeners.forEach((l) => l());
}

function clearTimer(id: ToastId) {
  const st = stateById.get(id);
  if (!st?.timeoutId) return;
  clearTimeout(st.timeoutId);
  st.timeoutId = null;
}

function startTimer(id: ToastId) {
  const st = stateById.get(id);
  if (!st || st.paused) return;

  clearTimer(id);
  st.startedAt = Date.now();

  st.timeoutId = setTimeout(() => {
    dismiss(id);
  }, Math.max(0, st.remaining));
}

function ensureTimerState(id: ToastId, durationInput: number | typeof Infinity | undefined) {
  if (durationInput === Infinity) {
    clearTimer(id);
    stateById.delete(id);
    emit(id);
    return;
  }

  const duration = typeof durationInput === 'number' ? durationInput : DEFAULT_DURATION_MS;
  const next: ToastTimerState = {
    duration,
    remaining: duration,
    startedAt: Date.now(),
    timeoutId: null,
    paused: false,
  };

  stateById.set(id, next);
  emit(id);
  startTimer(id);
}

function pause(id: ToastId) {
  const st = stateById.get(id);
  if (!st || st.paused) return;

  const elapsed = Date.now() - st.startedAt;
  st.remaining = Math.max(0, st.remaining - elapsed);
  st.paused = true;
  clearTimer(id);
  emit(id);
}

function resume(id: ToastId) {
  const st = stateById.get(id);
  if (!st || !st.paused) return;

  st.paused = false;
  emit(id);
  startTimer(id);
}

function dismiss(id?: ToastId) {
  if (typeof id === 'undefined') {
    const ids = Array.from(stateById.keys());
    ids.forEach((key) => dismiss(key));
    sonnerToast.dismiss();
    return;
  }

  clearTimer(id);
  stateById.delete(id);
  emit(id);
  sonnerToast.dismiss(id);
}

function getVariantClasses(variant: ToastVariant) {
  switch (variant) {
    case 'success':
      return 'border-emerald-500/30';
    case 'error':
      return 'border-red-500/30';
    case 'warning':
      return 'border-amber-500/30';
    case 'info':
      return 'border-sky-500/30';
    case 'loading':
      return 'border-muted';
    default:
      return 'border-border';
  }
}

function resolveVariant(input?: ToastObjectInput['variant']): ToastVariant {
  if (input === 'destructive') return 'error';
  if (input === 'default' || !input) return 'default';
  return input;
}

function renderToastContent(id: ToastId, variant: ToastVariant, title?: React.ReactNode, description?: React.ReactNode) {
  const st = React.useSyncExternalStore(
    React.useCallback((l) => subscribe(id, l), [id]),
    React.useCallback(() => getSnapshot(id), [id]),
    React.useCallback(() => getSnapshot(id), [id])
  );

  const paused = Boolean(st?.paused);

  return (
    <div className={`flex w-full items-start gap-3 rounded-md border p-4 ${getVariantClasses(variant)}`}>
      <div className="min-w-0 flex-1">
        {title ? (
          <div className="text-sm font-medium leading-5">
            {title}
            {paused ? <span className="ml-2 text-xs font-normal text-muted-foreground">(paused)</span> : null}
          </div>
        ) : null}
        {description ? <div className="mt-1 text-sm text-muted-foreground">{description}</div> : null}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          className={`inline-flex h-8 w-8 items-center justify-center rounded-md border text-sm leading-none transition-colors hover:bg-muted focus:outline-none focus:ring-2 focus:ring-ring ${
            paused ? 'bg-muted' : 'bg-background'
          }`}
          aria-label={paused ? 'Resume auto-dismiss' : 'Pause auto-dismiss'}
          onClick={() => {
            if (paused) resume(id);
            else pause(id);
          }}
        >
          ||
        </button>

        <button
          type="button"
          className="inline-flex h-8 w-8 items-center justify-center rounded-md border bg-background text-sm leading-none transition-colors hover:bg-muted focus:outline-none focus:ring-2 focus:ring-ring"
          aria-label="Dismiss notification"
          onClick={() => dismiss(id)}
        >
          X
        </button>
      </div>
    </div>
  );
}

function show(variant: ToastVariant, title?: React.ReactNode, description?: React.ReactNode, options?: ToastUpdateOptions) {
  const duration = options?.duration;
  const id: ToastId = options?.id ?? generateToastId();

  sonnerToast.custom(() => renderToastContent(id, variant, title, description), {
    id,
    duration: Infinity,
  });

  ensureTimerState(id, duration);

  return id;
}

function normalizeInput(input: unknown): ToastObjectInput {
  if (typeof input === 'string' || React.isValidElement(input)) {
    return { title: input };
  }
  if (input && typeof input === 'object') {
    return input as ToastObjectInput;
  }
  return {};
}

function baseToast(input: string | ToastObjectInput, opts?: ToastUpdateOptions) {
  const data = normalizeInput(input);
  return show(resolveVariant(data.variant), data.title, data.description, {
    id: opts?.id,
    duration: typeof data.duration !== 'undefined' ? data.duration : opts?.duration,
  });
}

baseToast.dismiss = dismiss;

baseToast.success = (message: string | ToastObjectInput, opts?: ToastUpdateOptions) => {
  const data = normalizeInput(message);
  return show('success', data.title, data.description, {
    id: opts?.id,
    duration: typeof data.duration !== 'undefined' ? data.duration : opts?.duration,
  });
};

baseToast.error = (message: string | ToastObjectInput, opts?: ToastUpdateOptions) => {
  const data = normalizeInput(message);
  return show('error', data.title, data.description, {
    id: opts?.id,
    duration: typeof data.duration !== 'undefined' ? data.duration : opts?.duration,
  });
};

baseToast.warning = (message: string | ToastObjectInput, opts?: ToastUpdateOptions) => {
  const data = normalizeInput(message);
  return show('warning', data.title, data.description, {
    id: opts?.id,
    duration: typeof data.duration !== 'undefined' ? data.duration : opts?.duration,
  });
};

baseToast.info = (message: string | ToastObjectInput, opts?: ToastUpdateOptions) => {
  const data = normalizeInput(message);
  return show('info', data.title, data.description, {
    id: opts?.id,
    duration: typeof data.duration !== 'undefined' ? data.duration : opts?.duration,
  });
};

baseToast.loading = (message: string | ToastObjectInput, opts?: ToastUpdateOptions) => {
  const data = normalizeInput(message);
  return show('loading', data.title, data.description, {
    id: opts?.id,
    duration: typeof data.duration !== 'undefined' ? data.duration : Infinity,
  });
};

export const toast = baseToast as typeof baseToast & {
  dismiss: typeof dismiss;
  success: (message: string | ToastObjectInput, opts?: ToastUpdateOptions) => ToastId;
  error: (message: string | ToastObjectInput, opts?: ToastUpdateOptions) => ToastId;
  warning: (message: string | ToastObjectInput, opts?: ToastUpdateOptions) => ToastId;
  info: (message: string | ToastObjectInput, opts?: ToastUpdateOptions) => ToastId;
  loading: (message: string | ToastObjectInput, opts?: ToastUpdateOptions) => ToastId;
};

export function useGlobalToast() {
  return { toast };
}
