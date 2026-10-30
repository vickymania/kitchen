package works.vexed.groceries

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.text.NumberFormat
import kotlin.math.floor
import kotlin.math.roundToInt

/**
 * "400 gr", "2–3 tenen", "½ el": the Kotlin twin of formatAmount in
 * public/app/i18n.js and formatQty in public/shared/ingredients.js. The unit
 * labels are plurals in res/values/units.xml and res/values-nl/units.xml,
 * written by tools/android_units.py from "units" in public/i18n/en.json and nl.json.
 */
object Amounts {
    fun format(context: Context, amounts: JSONArray): String =
        (0 until amounts.length()).map { one(context, amounts.getJSONObject(it)) }.filter { it.isNotEmpty() }.joinToString(" + ")

    private fun one(context: Context, a: JSONObject): String {
        if (a.has("text")) return a.optString("text")
        if (a.isNull("qty")) return ""
        val qty = a.getDouble("qty")
        val max = if (a.isNull("qty_max")) null else a.getDouble("qty_max")
        val q = qty(context, qty) + (max?.let { "–" + qty(context, it) } ?: "")
        val unit = if (a.isNull("unit")) null else a.getString("unit")
        val label = unit?.let { label(context, it, max ?: qty) }.orEmpty()
        return if (label.isEmpty()) q else "$q $label"
    }

    fun qty(context: Context, n: Double): String {
        val whole = floor(n)
        val frac = ((n - whole) * 100).roundToInt() / 100.0
        val glyph = mapOf(0.25 to "¼", 0.5 to "½", 0.75 to "¾", 0.33 to "⅓", 0.67 to "⅔")[frac]
        if (glyph != null && n < 10) return (if (whole > 0) whole.toInt().toString() else "") + glyph
        return NumberFormat.getNumberInstance(context.resources.configuration.locales[0])
            .apply { maximumFractionDigits = 2 }.format(n)
    }

    /** "€1,19" in Dutch, "€1.19" in English; the twin of money() in public/app/product.js. */
    fun money(context: Context, cents: Int?): String {
        if (cents == null) return ""
        return NumberFormat.getCurrencyInstance(context.resources.configuration.locales[0])
            .apply { currency = java.util.Currency.getInstance("EUR") }.format(cents / 100.0)
    }

    /** "1 nov" from "2026-11-01". */
    fun day(context: Context, iso: String): String = runCatching {
        java.time.LocalDate.parse(iso)
            .format(java.time.format.DateTimeFormatter.ofPattern("d MMM", context.resources.configuration.locales[0]))
            .trimEnd('.')
    }.getOrDefault(iso)

    private fun label(context: Context, unit: String, qty: Double): String {
        val id = context.resources.getIdentifier("unit_$unit", "plurals", context.packageName)
        if (id == 0) return unit
        return context.resources.getQuantityString(id, if (qty == 1.0 || qty < 1) 1 else 2)
    }
}
