package works.vexed.groceries

import kotlin.math.floor
import kotlin.math.roundToInt
import android.content.Context

/**
 * What a "Binnenkort nodig" row says: "nog 5 · ~6 dagen", "nog 100 g",
 * "gisteren op". The twin of soonText, amountText and supplyText in
 * public/app/pantry.js; the amount comes rounded from the server
 * (leftAmount in public/shared/needed-soon.js).
 */
object SoonText {
    fun of(context: Context, soon: ListState.Soon): String {
        val res = context.resources
        if (soon.code == "empty") {
            val ago = soon.on?.let { daysAgo(it) } ?: 0
            return if (ago <= 0) context.getString(R.string.soon_empty_today) else res.getQuantityString(R.plurals.soon_empty_ago, ago, ago)
        }
        val left = context.getString(R.string.soon_left, amount(context, soon.qty, soon.base))
        return soon.daysLeft?.let { "$left · ${supply(context, it)}" } ?: left
    }

    private fun amount(context: Context, qty: Double, base: String?): String {
        val n = Amounts.qty(context, qty)
        return when (base) {
            "g", "ml" -> "$n $base"
            "piece" -> "$n ${context.getString(R.string.soon_pieces)}"
            else -> n
        }
    }

    /** "~5 dagen", "~5 weken", "~2 maanden". */
    private fun supply(context: Context, days: Int): String {
        val res = context.resources
        val d = maxOf(0, days)
        return when {
            d >= 60 -> (d / 30.0).roundToInt().let { res.getQuantityString(R.plurals.supply_months, it, it) }
            d >= 14 -> (d / 7.0).roundToInt().let { res.getQuantityString(R.plurals.supply_weeks, it, it) }
            else -> res.getQuantityString(R.plurals.supply_days, d, d)
        }
    }

    private fun daysAgo(iso: String): Int = runCatching {
        val then = java.time.LocalDate.parse(iso)
        floor(java.time.temporal.ChronoUnit.DAYS.between(then, java.time.LocalDate.now(ListState.ZONE)).toDouble()).toInt()
    }.getOrDefault(0)
}
