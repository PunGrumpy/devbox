import { Schema } from "effect";

/**
 * JSON text read as `schema`. A test that looks inside a parsed value says here which part of it
 * it relies on, and gets an error that names the missing field when the text does not fit.
 */
export const readJson = <T, E>(schema: Schema.Codec<T, E>, text: string) =>
  Schema.decodeUnknownSync(Schema.fromJsonString(schema))(text);
