export * as SkillMarketplace from "./skill-marketplace.js"

import { Option, Result, Schema, SchemaGetter } from "effect"
import { NonNegativeInt, PositiveInt, optional } from "./schema.js"

/**
 * Catalog row identifier: a slug like `author-repo-skills-name`, not a local
 * `Skill.ID`. It is the catalog's own key and is never minted here.
 */
export const SkillID = Schema.String.pipe(Schema.brand("SkillMarketplace.SkillID"))
export type SkillID = typeof SkillID.Type

/**
 * Detected language of the skill's content. The catalog documents a closed set,
 * and every one of the 2072 skills cached by the retired MCP proxy used a code
 * from it. `mul` is mixed-language content, `und` means the detector gave up,
 * and `null` means the catalog has no language metadata at all.
 */
export const ContentLanguage = Schema.Literals([
  "en",
  "zh",
  "ja",
  "ko",
  "es",
  "pt",
  "de",
  "fr",
  "ar",
  "afr",
  "aka",
  "amh",
  "aze",
  "bel",
  "ben",
  "bul",
  "cat",
  "ces",
  "cym",
  "dan",
  "ell",
  "epo",
  "est",
  "fin",
  "guj",
  "heb",
  "hin",
  "hrv",
  "hun",
  "hye",
  "ind",
  "ita",
  "jav",
  "kan",
  "kat",
  "kaz",
  "khm",
  "lat",
  "lav",
  "lit",
  "mal",
  "mar",
  "mkd",
  "msa",
  "mya",
  "nep",
  "nld",
  "nob",
  "ori",
  "pan",
  "pes",
  "pol",
  "ron",
  "rus",
  "sin",
  "slk",
  "slv",
  "sna",
  "srp",
  "swa",
  "swe",
  "tam",
  "tel",
  "tgl",
  "tha",
  "tuk",
  "tur",
  "ukr",
  "urd",
  "uzb",
  "vie",
  "yid",
  "zul",
  "mul",
  "und",
]).annotate({ identifier: "SkillMarketplace.ContentLanguage" })
export type ContentLanguage = typeof ContentLanguage.Type

/** Ordering the catalog was asked for. */
export const SortOrder = Schema.Literals(["stars", "recent", "relevance"]).annotate({
  identifier: "SkillMarketplace.SortOrder",
})
export type SortOrder = typeof SortOrder.Type

/**
 * Rows one page may hold. The catalog documents fifty as the ceiling and never
 * answered above it. Like the shared integer schemas this cannot carry an
 * `identifier` annotation, because a checked schema drops it.
 */
export const PageLimit = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(50))
export type PageLimit = typeof PageLimit.Type

export interface Skill extends Schema.Schema.Type<typeof Skill> {}
export const Skill = Schema.Struct({
  id: SkillID,
  name: Schema.String,
  author: Schema.String,
  description: Schema.String,
  contentLanguage: optional(Schema.NullOr(ContentLanguage)),
  githubUrl: Schema.String,
  skillUrl: Schema.String,
  stars: NonNegativeInt,
  updatedAt: NonNegativeInt,
}).annotate({ identifier: "SkillMarketplace.Skill" })

/** Pagination exactly as the catalog sends it, including the two names it reuses. */
const WirePagination = Schema.Struct({
  page: PositiveInt,
  limit: PageLimit,
  total: NonNegativeInt,
  totalPages: PositiveInt,
  hasNext: Schema.Boolean,
  hasPrev: Schema.Boolean,
  totalIsExact: Schema.Boolean,
})

/**
 * The same page under names that say what they hold.
 *
 * The catalog calls its row counter `total`, but it is not the size of the
 * catalog: over all 312 cached listings it equalled the returned row count
 * exactly when `totalIsExact` was true, and was otherwise always that count
 * plus one row known to sit behind the page. A field called `total` is read as
 * a catalog size within a year, so it is decoded under a name that cannot be.
 */
const NamedPagination = Schema.Struct({
  page: PositiveInt,
  limit: PageLimit,
  /** The rows the catalog has proven so far, and the ceiling for `provenPageCount`. */
  provenRowCount: NonNegativeInt,
  /** Page count when `totalIsExact`, otherwise the page horizon known so far. */
  provenPageCount: PositiveInt,
  hasNext: Schema.Boolean,
  hasPrev: Schema.Boolean,
  totalIsExact: Schema.Boolean,
})

export interface Pagination extends Schema.Schema.Type<typeof Pagination> {}
export const Pagination = WirePagination.pipe(
  Schema.decodeTo(NamedPagination, {
    decode: SchemaGetter.transform((wire: Schema.Schema.Type<typeof WirePagination>) => ({
      page: wire.page,
      limit: wire.limit,
      provenRowCount: wire.total,
      provenPageCount: wire.totalPages,
      hasNext: wire.hasNext,
      hasPrev: wire.hasPrev,
      totalIsExact: wire.totalIsExact,
    })),
    encode: SchemaGetter.transform((named: Schema.Schema.Type<typeof NamedPagination>) => ({
      page: named.page,
      limit: named.limit,
      total: named.provenRowCount,
      totalPages: named.provenPageCount,
      hasNext: named.hasNext,
      hasPrev: named.hasPrev,
      totalIsExact: named.totalIsExact,
    })),
  }),
).annotate({ identifier: "SkillMarketplace.Pagination" })

/**
 * The filters the catalog echoes back. It documents neither this object nor
 * which parameters it echoes, so each field stands for a parameter the request
 * carried, and a listing that omits one is not malformed.
 */
export interface Filters extends Schema.Schema.Type<typeof Filters> {}
export const Filters = Schema.Struct({
  search: optional(Schema.String),
  sortBy: optional(SortOrder),
}).annotate({ identifier: "SkillMarketplace.Filters" })

/**
 * Per-request diagnostics. Present in every cached response but never required
 * by the catalog's own description, so a listing without it still decodes.
 */
export interface Meta extends Schema.Schema.Type<typeof Meta> {}
export const Meta = Schema.Struct({
  requestId: Schema.String,
  responseTimeMs: NonNegativeInt,
}).annotate({ identifier: "SkillMarketplace.Meta" })

export interface Data extends Schema.Schema.Type<typeof Data> {}
export const Data = Schema.Struct({
  skills: Schema.Array(Skill),
  pagination: Pagination,
  filters: Filters,
}).annotate({ identifier: "SkillMarketplace.Data" })

export interface Listing extends Schema.Schema.Type<typeof Listing> {}
export const Listing = Schema.Struct({
  success: Schema.Literal(true),
  data: Data,
  meta: optional(Meta),
}).annotate({ identifier: "SkillMarketplace.Listing" })

/**
 * A refusal the catalog returns with a successful HTTP status, so the status
 * alone cannot tell a listing from a failure. `code` stays an open string on
 * purpose: the catalog documents no enumeration and has already answered with
 * `DAILY_QUOTA_EXCEEDED`, `SEARCH_INDEX_UNAVAILABLE` and `MISSING_QUERY`.
 */
export interface ErrorBody extends Schema.Schema.Type<typeof ErrorBody> {}
export const ErrorBody = Schema.Struct({
  success: Schema.Literal(false),
  error: Schema.Struct({
    code: Schema.String,
    message: Schema.String,
  }).annotate({ identifier: "SkillMarketplace.ErrorDetail" }),
}).annotate({ identifier: "SkillMarketplace.ErrorBody" })

export type Response = typeof Response.Type
export const Response = Schema.Union([Listing, ErrorBody]).annotate({ identifier: "SkillMarketplace.Response" })

/**
 * Whether a body is the catalog refusing rather than answering. Anything else
 * must not reach a caller as an empty result set: a refusal read as "no skills
 * match" is the failure this contract exists to prevent.
 */
export const isError = Schema.is(ErrorBody)

/** Why a body could not be read as either shape. */
export interface DecodeFailure extends Schema.Schema.Type<typeof DecodeFailure> {}
export const DecodeFailure = Schema.Struct({
  reason: Schema.Literals(["malformed_json", "unexpected_shape"]),
  message: Schema.String,
}).annotate({ identifier: "SkillMarketplace.DecodeFailure" })

const decodeResponse = Schema.decodeUnknownOption(Schema.fromJsonString(Response))
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

/**
 * Reads one catalog body. A body that cannot be recognised fails loudly,
 * because reporting an unreadable answer as zero skills found is worse than
 * admitting the catalog answered something this contract cannot read.
 */
export function parse(body: string): Result.Result<Response, DecodeFailure> {
  const response = decodeResponse(body)
  if (Option.isSome(response)) return Result.succeed(response.value)
  if (Option.isNone(decodeJson(body)))
    return Result.fail({ reason: "malformed_json", message: `catalog body is not JSON: ${preview(body)}` })
  return Result.fail({
    reason: "unexpected_shape",
    message: `catalog body is neither listing nor error: ${preview(body)}`,
  })
}

/** Enough of an unreadable body to recognise it in a log, without logging all of it. */
function preview(body: string) {
  return body.slice(0, 200)
}
