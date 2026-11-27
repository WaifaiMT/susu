"use client";

import { startTransition, useActionState, useEffect, useRef, type ReactNode } from "react";
import type { ActionState } from "@/lib/actions";

type Props = {
  action: (prev: ActionState, form: FormData) => Promise<ActionState>;
  children: ReactNode;
  submitLabel: string;
  pendingLabel?: string;
  variant?: "primary" | "danger" | "secondary";
  className?: string;
  /** Asks for confirmation before submitting (for destructive actions). */
  confirm?: string;
};

const VARIANTS = {
  primary: "bg-indigo-600 text-white hover:bg-indigo-500",
  danger: "bg-rose-600 text-white hover:bg-rose-500",
  secondary: "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50",
};

const INITIAL: ActionState = {};

/**
 * A form wired to a server action, with a pending state and inline error or
 * success message. It submits from onSubmit rather than the `action` prop:
 * React resets `action` forms after every submit, which would wipe what the
 * user typed when the server returns an error. Here the form only resets
 * after a successful submit.
 */
export function ActionForm({ action, children, submitLabel, pendingLabel, variant = "primary", className, confirm }: Props) {
  const [state, formAction, pending] = useActionState(action, INITIAL);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state !== INITIAL && !state.error) formRef.current?.reset();
  }, [state]);

  return (
    <form
      ref={formRef}
      className={className ?? "space-y-3"}
      onSubmit={(e) => {
        e.preventDefault();
        if (confirm && !window.confirm(confirm)) return;
        const data = new FormData(e.currentTarget);
        startTransition(() => formAction(data));
      }}
    >
      {children}
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className={`rounded-md px-3.5 py-2 text-sm font-medium shadow-sm transition disabled:opacity-60 ${VARIANTS[variant]}`}
        >
          {pending ? (pendingLabel ?? "Working…") : submitLabel}
        </button>
        {state.error && (
          <p role="alert" className="text-sm text-rose-700">
            {state.error}
          </p>
        )}
        {state.message && <p className="text-sm text-emerald-700">{state.message}</p>}
      </div>
    </form>
  );
}

export function Field({
  label,
  name,
  type = "text",
  required = true,
  placeholder,
  defaultValue,
  autoComplete,
  inputMode,
  min,
  max,
  hint,
}: {
  label: string;
  name: string;
  type?: string;
  required?: boolean;
  placeholder?: string;
  defaultValue?: string;
  autoComplete?: string;
  inputMode?: "decimal" | "numeric" | "text" | "email";
  min?: string;
  max?: string;
  hint?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-slate-700">{label}</span>
      <input
        name={name}
        type={type}
        required={required}
        placeholder={placeholder}
        defaultValue={defaultValue}
        autoComplete={autoComplete}
        inputMode={inputMode}
        min={min}
        max={max}
        className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
      />
      {hint && <span className="mt-1 block text-xs text-slate-500">{hint}</span>}
    </label>
  );
}

export function SelectField({
  label,
  name,
  options,
  defaultValue,
}: {
  label: string;
  name: string;
  options: { value: string; label: string }[];
  defaultValue?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-slate-700">{label}</span>
      <select
        name={name}
        defaultValue={defaultValue}
        className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
