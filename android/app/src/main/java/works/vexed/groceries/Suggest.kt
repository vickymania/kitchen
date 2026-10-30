package works.vexed.groceries

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.text.Normalizer
import java.util.Locale

/**
 * The add dialog's suggestions (1.6), offline: the Kotlin twin of
 * public/shared/suggest.js on the names list of GET /api/widget/names
 * (worker/widget.js widgetNames: the items bought most, their other names and
 * any-store product, never an excluded thing). Same tiers, same order:
 *   0 exact, 1 the same without spaces, 2 word starts / prefix, 3 a typo.
 * Only 0 and 1 may link by themselves; a typo is only ever offered.
 * PAIR: change a rule here, change it in public/shared/suggest.js.
 */
object Suggest {
    data class Name(val id: String, val name: String, val aliases: List<String>, val product: String?, val score: Double)

    data class Hit(val name: Name, val tier: Int, val via: String?)

    private class Parts(val text: String, val key: String, val alias: Boolean) {
        val compact = key.replace(" ", "")
        val words = if (key.isEmpty()) emptyList() else key.split(" ")
    }

    const val MAX = 4

    /** nameKey in public/shared/ingredients.js. */
    fun nameKey(name: String): String {
        val lower = name.lowercase(Locale.ROOT).replace(Regex("\\([^)]*\\)"), " ")
        val plain = Normalizer.normalize(lower, Normalizer.Form.NFD).replace(Regex("[\\u0300-\\u036f]"), "")
        return plain.replace(Regex("[^a-z0-9 ]+"), " ").replace(Regex("\\s+"), " ").trim()
    }

    fun fuzzyMax(length: Int) = if (length <= 3) 0 else if (length <= 5) 1 else 2

    /** Damerau-Levenshtein (optimal string alignment), or max + 1 once it is certainly more. */
    fun editDistance(a: String, b: String, max: Int): Int {
        if (Math.abs(a.length - b.length) > max) return max + 1
        var prev2: IntArray? = null
        var prev = IntArray(b.length + 1) { it }
        for (i in 1..a.length) {
            val cur = IntArray(b.length + 1)
            cur[0] = i
            var best = i
            for (j in 1..b.length) {
                val cost = if (a[i - 1] == b[j - 1]) 0 else 1
                var v = minOf(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
                if (prev2 != null && i > 1 && j > 1 && a[i - 1] == b[j - 2] && a[i - 2] == b[j - 1]) v = minOf(v, prev2[j - 2] + 1)
                cur[j] = v
                if (v < best) best = v
            }
            if (best > max) return max + 1
            prev2 = prev
            prev = cur
        }
        return prev[b.length]
    }

    private fun near(typed: String, word: String, prefix: Boolean): Boolean {
        val max = fuzzyMax(typed.length)
        if (max == 0) return false
        if (editDistance(typed, word, max) <= max) return true
        if (!prefix || typed.length < 5) return false
        for (n in typed.length - 1..typed.length + 1) {
            if (n > 0 && n < word.length && editDistance(typed, word.substring(0, n), 1) <= 1) return true
        }
        return false
    }

    private fun tier(t: Parts, n: Parts): Int? {
        if (t.compact.isEmpty() || n.compact.isEmpty()) return null
        if (n.key == t.key) return 0
        if (n.compact == t.compact) return 1
        if (n.compact.startsWith(t.compact)) return 2
        if (t.words.all { w -> n.words.any { it.startsWith(w) } }) return 2
        if (near(t.compact, n.compact, true)) return 3
        if (t.words.isNotEmpty() && t.words.all { w -> n.words.any { it.startsWith(w) || near(w, it, true) } }) return 3
        return null
    }

    /** Up to `limit` suggestions for what was typed (the name part, without an amount). */
    fun suggest(names: List<Name>, text: String, limit: Int = MAX): List<Hit> {
        val t = Parts(text, nameKey(text), false)
        if (t.compact.isEmpty()) return emptyList()
        val out = ArrayList<Hit>()
        for (c in names) {
            var best: Pair<Int, Parts>? = null
            val all = listOf(Parts(c.name, nameKey(c.name), false)) + c.aliases.map { Parts(it, nameKey(it), true) }
            for (n in all) {
                val tr = tier(t, n) ?: continue
                if (best == null || tr < best.first || (tr == best.first && best.second.alias && !n.alias)) best = tr to n
            }
            if (best != null) out.add(Hit(c, best.first, if (best.second.alias) best.second.text else null))
        }
        val collator = java.text.Collator.getInstance(Locale("nl")).apply { strength = java.text.Collator.PRIMARY }
        return out.sortedWith(compareBy<Hit> { it.tier }.thenByDescending { it.name.score }.thenComparator { a, b -> collator.compare(a.name.name, b.name.name) })
            .take(limit)
    }

    /** The amount part of a typed line is not part of the name: "2 mino" -> "mino" (a rough cut; the server parses for real). */
    fun namePart(line: String): String =
        line.trim().replace(Regex("^[0-9]+([.,/][0-9]+)?\\s*(x|st|stuks?|g|gr|gram|kg|ml|l|liter|pak|pakken|zak|zakken|blik|blikken|fles|flessen|bos)?\\s+", RegexOption.IGNORE_CASE), "")

    // ------------------------------------------------------------ the cache

    private fun prefs(context: Context) = context.getSharedPreferences("names", Context.MODE_PRIVATE)

    fun names(context: Context): List<Name> {
        val raw = prefs(context).getString(KEY_NAMES, null) ?: return emptyList()
        val list = runCatching { JSONObject(raw).getJSONArray("names") }.getOrNull() ?: return emptyList()
        return (0 until list.length()).map { i ->
            val o = list.getJSONObject(i)
            val a = o.optJSONArray("a") ?: JSONArray()
            Name(o.getString("i"), o.getString("n"), (0 until a.length()).map { a.getString(it) },
                o.optString("p").ifEmpty { null }, o.optDouble("s", 0.0))
        }
    }

    /** Fetched once a day (Amsterdam), or when there is none yet. */
    fun stale(context: Context): Boolean {
        val raw = prefs(context).getString(KEY_NAMES, null) ?: return true
        val day = runCatching { JSONObject(raw).optString("day") }.getOrNull()
        return day != java.time.LocalDate.now(ListState.ZONE).toString()
    }

    fun refreshIfStale(context: Context, token: String) {
        if (!stale(context)) return
        prefs(context).edit().putString(KEY_NAMES, Api.widgetNames(token).toString()).apply()
    }

    fun clear(context: Context) {
        prefs(context).edit().clear().apply()
    }

    private const val KEY_NAMES = "names"
}
