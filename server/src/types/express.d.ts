/**
 * Declaration merging for the one property the auth middleware attaches.
 *
 * Typed as optional rather than required, which is the honest shape: a request
 * on an unauthenticated route genuinely does not have it. Declaring it
 * non-optional would make `request.userId` type-check everywhere and be
 * `undefined` at runtime on any route missing the middleware -- the exact bug
 * `requireUserId` exists to catch.
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

export {};
