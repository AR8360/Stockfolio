import { z } from 'zod';

/**
 * Zod schemas for Yahoo's unofficial endpoints (IMPLEMENTATION_PLAN.md §4.1).
 *
 * Written against payloads actually captured from the live endpoints (see
 * `__fixtures__/`), not against documentation -- there is no documentation for
 * these endpoints, and the shapes differ from every third-party write-up of
 * them. An external API is untrusted input in exactly the sense a form
 * submission is (ASSUMPTIONS.md #14); parsing here turns a provider change
 * into a caught, typed error at one seam instead of `undefined` arriving three
 * layers deeper in the FIFO calculator.
 *
 * Deliberately permissive about fields we do not use: these schemas are NOT
 * `.strict()`, unlike the request schemas at the route boundary. Yahoo adds
 * response fields without warning, and rejecting an unknown field would turn
 * their routine change into our outage. The rule is: validate everything we
 * read, ignore everything we do not.
 */

/** Yahoo emits `null` for fields it has no value for, and simply omits others,
 *  inconsistently between endpoints. This treats both the same way. */
const nullableNumber = z.number().finite().nullish();

/**
 * The `meta` block of a v8 chart response. This is the only unauthenticated
 * source of a current price left: `/v7/finance/quote`, the batch endpoint the
 * plan assumed for the movers basket (§5), now returns 401 -- Yahoo put it
 * behind a crumb/cookie. Everything the movers calculation needs happens to be
 * present here, at the cost of one request per symbol instead of one per
 * basket.
 */
export const chartMetaSchema = z.object({
  symbol: z.string().min(1),
  currency: z.string().min(1),
  /** "NSE" / "BSE" -- the display name. `exchangeName` is the terse internal
   *  code ("NSI") and is not what we want to show or store. */
  fullExchangeName: z.string().min(1),
  instrumentType: z.string().optional(),

  longName: z.string().optional(),
  shortName: z.string().optional(),

  regularMarketPrice: z.number().finite(),
  /** Seconds since epoch, not milliseconds. */
  regularMarketTime: z.number().int(),
  regularMarketVolume: nullableNumber,
  regularMarketDayHigh: nullableNumber,
  regularMarketDayLow: nullableNumber,

  /** Previous close is named `chartPreviousClose` on this endpoint (it is
   *  `regularMarketPreviousClose` on the v7 quote endpoint). Required, because
   *  every change/percent figure is derived from it. */
  chartPreviousClose: z.number().finite(),

  /**
   * Decimal places this instrument actually quotes to (2 for INR equities).
   *
   * Not cosmetic. Yahoo serializes historical OHLC at float32 precision, so a
   * close that traded at 2200.80 arrives as 2200.800048828125. Carrying that
   * noise forward would render a nonsense price and would put a value into the
   * app whose extra digits are pure artefact. This field is the provider's own
   * statement of the real precision, so it is preferred over hardcoding 2 --
   * which would be wrong for instruments quoted to more places.
   */
  priceHint: z.number().int().min(0).max(10).optional(),
});

export type ChartMeta = z.infer<typeof chartMetaSchema>;

/** Daily OHLCV arrays. Yahoo returns these as parallel arrays indexed against
 *  `timestamp`, with `null` at holidays/halts -- so the arrays are the same
 *  length but individually gappy, and entries must be zipped by index and then
 *  filtered, never assumed dense. */
export const chartIndicatorsSchema = z.object({
  quote: z
    .array(
      z.object({
        open: z.array(nullableNumber).optional(),
        high: z.array(nullableNumber).optional(),
        low: z.array(nullableNumber).optional(),
        close: z.array(nullableNumber).optional(),
        volume: z.array(nullableNumber).optional(),
      }),
    )
    .min(1),
});

export const chartResultSchema = z.object({
  meta: chartMetaSchema,
  timestamp: z.array(z.number().int()).optional(),
  indicators: chartIndicatorsSchema.optional(),
});

/**
 * The envelope. Yahoo signals "no such symbol" *inside* a body that may carry
 * a 200 or a 404, so the HTTP status alone cannot be trusted to classify the
 * outcome -- `chart.error` has to be read either way. This is precisely the
 * class of provider quirk assumption #14 wanted confined to one file.
 */
export const chartResponseSchema = z.object({
  chart: z.object({
    result: z.array(chartResultSchema).nullable(),
    error: z
      .object({
        code: z.string(),
        description: z.string(),
      })
      .nullable(),
  }),
});

export type ChartResponse = z.infer<typeof chartResponseSchema>;

/** Search. `quotes` mixes equities, ETFs, futures, currencies and indices;
 *  filtering to what this app can actually record as a trade happens in the
 *  mapper, not here -- the schema's job is shape, not policy. */
export const searchResponseSchema = z.object({
  quotes: z.array(
    z.object({
      symbol: z.string().min(1),
      quoteType: z.string().optional(),
      /** Present on equities, absent on some other instrument types. */
      exchDisp: z.string().optional(),
      shortname: z.string().optional(),
      longname: z.string().optional(),
    }),
  ),
});

export type SearchResponse = z.infer<typeof searchResponseSchema>;
