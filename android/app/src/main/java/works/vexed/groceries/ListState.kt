package works.vexed.groceries

import android.content.Context
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONArray
import org.json.JSONObject

/**
 * What the widget shows: the answer of GET /api/widget (the open lines per
 * store, with their details) and the household rev it is true for. A refresh
 * sends ?since=rev; with nothing new the server reads one row and answers
 * "unchanged", so an idle refresh costs next to nothing.
 */
object ListState {
    data class Product(
        val name: String, val brand: String, val size: String, val store: String,
        val storeOnly: Boolean, val lastPriceCents: Int?, val forRecipe: String?,
    )

    data class Offer(val store: String, val name: String, val deal: String, val priceCents: Int?, val until: String, val mine: Boolean)

    data class Line(
        val id: String, val title: String, val amounts: JSONArray, val note: String, val recipes: List<String>,
        val product: Product?, val onlyAt: String?, val offer: Offer?,
    )

    /** store null = anywhere ("Overal"). */
    data class Group(val store: String?, val lines: List<Line>)

    /**
     * An "Al nodig?" row (1.4): what is left (qty in base "g", "ml", "piece",
     * or null for packs), the days of supply when it is counted down, and the
     * op its "Nog niet" sends (made by the server: notYetOp in
     * public/shared/needed-soon.js).
     */
    data class Soon(
        val key: String, val name: String, val code: String, val qty: Double, val base: String?,
        val daysLeft: Int?, val on: String?, val notYet: JSONObject?,
        /** 1.5: the list line the tick box makes ({ title, amounts }, tickEntry in needed-soon.js). */
        val tick: JSONObject?,
    )

    /** The day the server counts in (amsterdamDay in worker/offers.js). */
    val ZONE: java.time.ZoneId = java.time.ZoneId.of("Europe/Amsterdam")

    /** What runs out soon, soonest first, without the rows "Nog niet" was just tapped on; empty before the first refresh of 1.4. */
    fun neededSoon(context: Context): List<Soon> {
        val p = prefs(context)
        val stored = p.getString(KEY_WIDGET, null) ?: return emptyList()
        val rows = JSONObject(stored).optJSONArray("needed_soon") ?: return emptyList()
        val hidden = p.getStringSet(KEY_NOT_YET, emptySet())!!
        return (0 until rows.length()).map { rows.getJSONObject(it) }.map { o ->
            val amount = o.optJSONObject("amount") ?: JSONObject()
            Soon(
                o.optString("key"), o.optString("name"), o.optString("code"), amount.optDouble("qty", 0.0), amount.stringOrNull("base"),
                o.intOrNull("days_left"), o.stringOrNull("on"), o.optJSONObject("not_yet"), o.optJSONObject("tick"),
            )
        }.filter { it.key !in hidden }
    }

    /** The "Nog niet" op of one row, as the server made it. */
    fun notYetOp(context: Context, key: String): JSONObject? = neededSoon(context).firstOrNull { it.key == key }?.notYet

    /** The list line one row's tick box makes, as the server gave it. */
    fun tickEntry(context: Context, key: String): JSONObject? = neededSoon(context).firstOrNull { it.key == key }?.tick

    /** Hide a row at once while NotYetWorker sends its "Nog niet"; the next full refresh shows it as it then is. */
    fun markNotYet(context: Context, key: String) = editSet(context, KEY_NOT_YET) { it.add(key) }

    /** The "Nog niet" was refused: show the row again. */
    fun unmarkNotYet(context: Context, key: String) = editSet(context, KEY_NOT_YET) { it.remove(key) }

    private val lock = Mutex()

    private fun prefs(context: Context) = context.getSharedPreferences("list", Context.MODE_PRIVATE)

    /**
     * The groups in the server's order (AH, Dirk, other stores, anywhere),
     * without the lines this phone just ticked off and has not confirmed yet.
     * null until the first refresh after linking.
     */
    fun groups(context: Context): List<Group>? {
        val p = prefs(context)
        val stored = p.getString(KEY_WIDGET, null) ?: return null
        val ticked = p.getStringSet(KEY_TICKED, emptySet())!!
        val groups = JSONObject(stored).optJSONArray("groups") ?: JSONArray()
        return (0 until groups.length()).map { groups.getJSONObject(it) }.map { g ->
            val lines = g.getJSONArray("lines")
            Group(
                if (g.isNull("store")) null else g.getString("store"),
                (0 until lines.length()).map { lineOf(lines.getJSONObject(it)) }.filter { it.id !in ticked },
            )
        }.filter { it.lines.isNotEmpty() }
    }

    fun openCount(context: Context): Int? = groups(context)?.sumOf { it.lines.size }

    private fun lineOf(o: JSONObject): Line {
        val product = o.optJSONObject("product")?.let {
            Product(
                it.optString("name"), it.optString("brand"), it.optString("size"), it.optString("store"),
                it.optBoolean("store_only"), it.intOrNull("last_price_cents"), it.stringOrNull("for_recipe"),
            )
        }
        val offer = o.optJSONObject("offer")?.let {
            Offer(it.optString("store"), it.optString("name"), it.optString("deal"), it.intOrNull("price_cents"), it.optString("until"), it.optBoolean("mine"))
        }
        val recipes = o.optJSONArray("recipes") ?: JSONArray()
        return Line(
            o.getString("id"), o.optString("title"), o.optJSONArray("amounts") ?: JSONArray(), o.optString("note"),
            (0 until recipes.length()).map { recipes.getString(it) }, product, o.stringOrNull("only_at"), offer,
        )
    }

    private fun JSONObject.intOrNull(key: String) = if (isNull(key)) null else getInt(key)
    private fun JSONObject.stringOrNull(key: String) = if (isNull(key)) null else getString(key).ifEmpty { null }

    fun memberLine(context: Context): Pair<String, String>? {
        val p = prefs(context)
        val member = p.getString(KEY_MEMBER, null) ?: return null
        return member to p.getString(KEY_HOUSEHOLD, "").orEmpty()
    }

    fun saveMember(context: Context, member: String, household: String) {
        prefs(context).edit().putString(KEY_MEMBER, member).putString(KEY_HOUSEHOLD, household).apply()
    }

    /** Hide a line at once while CheckWorker sends the tick. */
    fun markTicked(context: Context, id: String) = editSet(context, KEY_TICKED) { it.add(id) }

    /** The tick was refused (the line was already gone): show what the server says again. */
    fun unmarkTicked(context: Context, id: String) = editSet(context, KEY_TICKED) { it.remove(id) }

    fun isExpanded(context: Context, id: String) = id in prefs(context).getStringSet(KEY_EXPANDED, emptySet())!!

    /** A tap on a line opens its details in place; a second tap closes them. */
    fun toggleExpanded(context: Context, id: String) = editSet(context, KEY_EXPANDED) { if (!it.remove(id)) it.add(id) }

    private fun editSet(context: Context, key: String, change: (MutableSet<String>) -> Unit) = synchronized(this) {
        val p = prefs(context)
        val set = HashSet(p.getStringSet(key, emptySet())!!).also(change)
        p.edit().putStringSet(key, set).commit()
    }

    suspend fun refresh(context: Context, token: String) = lock.withLock {
        val p = prefs(context)
        // Nothing stored yet (just linked, or the update from 1.1), or stored on
        // another day (1.4: a countdown moves with the day, not the rev): the whole list once.
        val today = java.time.LocalDate.now(ZONE).toString()
        val storedDay = p.getString(KEY_WIDGET, null)?.let { runCatching { JSONObject(it).optString("day") }.getOrNull() }
        val since = if (p.contains(KEY_WIDGET) && storedDay == today) p.getLong(KEY_REV, 0) else 0
        val answer = Api.widget(token, since)
        if (answer.optBoolean("unchanged")) return@withLock
        p.edit().putLong(KEY_REV, answer.getLong("rev")).putString(KEY_WIDGET, answer.toString()).remove(KEY_ENTRIES_V11).apply()
        // Lines gone from the list: a tick the server confirmed, or a line closed elsewhere.
        val live = HashSet<String>()
        val groups = answer.optJSONArray("groups") ?: JSONArray()
        for (i in 0 until groups.length()) {
            val lines = groups.getJSONObject(i).getJSONArray("lines")
            for (j in 0 until lines.length()) live.add(lines.getJSONObject(j).getString("id"))
        }
        editSet(context, KEY_TICKED) { it.retainAll(live) }
        editSet(context, KEY_EXPANDED) { it.retainAll(live) }
        // A "Nog niet" sent before this answer is in it: the rows show as they now are.
        editSet(context, KEY_NOT_YET) { it.clear() }
    }

    fun clear(context: Context) {
        prefs(context).edit().clear().apply()
    }

    private const val KEY_REV = "rev"
    private const val KEY_WIDGET = "widget"
    private const val KEY_ENTRIES_V11 = "entries"
    private const val KEY_TICKED = "ticked"
    private const val KEY_EXPANDED = "expanded"
    private const val KEY_NOT_YET = "not_yet"
    private const val KEY_MEMBER = "member"
    private const val KEY_HOUSEHOLD = "household"
}
