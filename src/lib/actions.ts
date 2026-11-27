import "server-only";
import { unstable_rethrow } from "next/navigation";
import { AppError } from "./errors";

export type ActionState = { error?: string; message?: string };

/**
 * Runs a server action body and turns expected failures (AppError) into a
 * message for the form. Anything else is logged and shown as a generic error,
 * so internal details never reach the browser.
 */
export async function runAction(fn: () => Promise<string | void>): Promise<ActionState> {
  try {
    const message = await fn();
    return message ? { message } : {};
  } catch (error) {
    // redirect() and notFound() work by throwing; let them through
    unstable_rethrow(error);
    if (error instanceof AppError) return { error: error.message };
    console.error(error);
    return { error: "Something went wrong. Please try again." };
  }
}
