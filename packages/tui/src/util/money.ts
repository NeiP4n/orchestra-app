import { createSignal } from "solid-js"

// Money the screens show is the operator's own: rubles, because the account that pays for the
// models is billed in rubles and every provider's price is read in them. The session ledger keeps
// USD, so prices and spend are converted here at one rate. It comes from the Polza provider
// settings (`provider.polza.settings.exchangeRate`) and falls back to the default below.
export const DEFAULT_EXCHANGE_RATE = 80

const [exchangeRate, setExchangeRate] = createSignal(DEFAULT_EXCHANGE_RATE)
export { exchangeRate }

export function configureExchangeRate(rublesPerUsd: number | undefined) {
  if (rublesPerUsd === undefined || !Number.isFinite(rublesPerUsd) || rublesPerUsd <= 0) return
  setExchangeRate(rublesPerUsd)
}

const rub = new Intl.NumberFormat("ru-RU", {
  style: "currency",
  currency: "RUB",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

const rubShort = new Intl.NumberFormat("ru-RU", {
  style: "currency",
  currency: "RUB",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
})

/** A USD-ledger amount (dollars) as rubles. */
export function formatMoney(usd: number) {
  return rub.format(usd * exchangeRate())
}

/** A ruble amount that already is rubles, such as the provider's own balance. */
export function formatRubles(rubles: number) {
  return rub.format(rubles)
}

/** Compact ruble amount for a narrow strip. */
export function formatRublesShort(rubles: number) {
  return rubShort.format(rubles)
}

/** A USD-ledger amount as rubles, without decimals, for narrow strips. */
export function formatMoneyShort(usd: number) {
  return rubShort.format(usd * exchangeRate())
}
