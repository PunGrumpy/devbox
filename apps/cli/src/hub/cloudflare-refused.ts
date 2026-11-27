import { Schema } from "effect";

/** Cloudflare answered with an error, or did not answer at all (status null). */
export class CloudflareRefused extends Schema.TaggedError<CloudflareRefused>()(
  "CloudflareRefused",
  { status: Schema.NullOr(Schema.Number), said: Schema.String }
) {}
