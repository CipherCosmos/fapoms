import { IsOptional, IsString, IsNumber, MaxLength, Matches } from 'class-validator';

/**
 * The only URL shape a report may reference for an attachment.
 *
 * Attachments are rendered as links and fetched with the caller's session. A value the server
 * never issued — a `javascript:` url, somebody else's host, or a path into another feature's
 * files — is a stored redirect at best. The upload route issues exactly this shape and nothing
 * else is accepted.
 *
 * No dot-segments: `..` inside a path is how a key climbs out of the prefix it was meant to
 * stay in. The download route checks separately that a thread actually references the key, so
 * a traversal could not have been served — but a validator that claims to be the gate should
 * not be the weaker of the two checks.
 */
export const FEEDBACK_ATTACHMENT_URL =
  /^\/api\/v1\/feedback\/attachments\/(?!.*(?:^|[/%])\.\.(?:[/%]|$))[\w.%-]+(?:\/[\w.%-]+)*$/;

/**
 * One file attached to a piece of feedback.
 *
 * A class, not an inline type, and used with `@ValidateNested` + `@Type` — because the global
 * ValidationPipe runs `whitelist: true` and strips any property it has no validator metadata
 * for, and an inline TypeScript type carries none at runtime. An attachment posted with a
 * report used to arrive as `[[]]` in the database: the API answered 201, the thread saved, and
 * the file details were simply gone.
 */
export class FeedbackAttachmentDto {
  @IsString()
  @Matches(FEEDBACK_ATTACHMENT_URL, {
    message: 'An attachment URL must be one this API issued from the feedback upload route.',
  })
  url: string;

  @IsString() @MaxLength(255) fileName: string;
  @IsString() @MaxLength(150) fileType: string;

  /** Returned by the upload route and posted back verbatim; declared so they are not rejected. */
  @IsOptional() @IsString() @MaxLength(512) storageKey?: string;
  @IsOptional() @IsNumber() size?: number;
}
