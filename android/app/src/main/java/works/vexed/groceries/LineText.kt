package works.vexed.groceries

import android.content.Context

/**
 * The words under a line in the widget, the same pieces the web app shows on
 * its list (public/app/groceries.js: productLine, onlyAtLine, dealLine).
 */
object LineText {
    /** Collapsed: one short line. "→ AH Halfvolle melk · halfvol · % AH 2e halve prijs". */
    fun short(context: Context, line: ListState.Line): String {
        val parts = mutableListOf<String>()
        when {
            line.onlyAt != null -> parts.add(context.getString(R.string.only_at, line.onlyAt))
            line.product != null -> parts.add("→ ${productName(line.product)}")
        }
        if (line.note.isNotBlank()) parts.add(line.note)
        line.offer?.let { parts.add(context.getString(R.string.offer_tag, "${shortStore(it.store)} ${it.deal}".trim())) }
        return parts.joinToString(" · ")
    }

    /** Expanded: note, product with its price, store, the offer, the recipes. */
    fun details(context: Context, line: ListState.Line): String {
        val out = mutableListOf<String>()
        if (line.note.isNotBlank()) out.add(line.note)
        line.product?.let { p ->
            out.add(listOf("→ ${productName(p)}", p.size, Amounts.money(context, p.lastPriceCents))
                .filter { it.isNotBlank() }.joinToString(" · "))
        }
        line.onlyAt?.let { out.add(context.getString(R.string.only_at, it)) }
        line.offer?.let { o ->
            val head = if (o.mine) "${context.getString(R.string.deal_mine)} · ${o.store}" else "${o.store} · ${o.name}"
            out.add(listOf(head, o.deal, Amounts.money(context, o.priceCents), context.getString(R.string.deal_until, Amounts.day(context, o.until)))
                .filter { it.isNotBlank() }.joinToString(" · "))
        }
        val recipes = (line.recipes + listOfNotNull(line.product?.forRecipe)).distinct()
        if (recipes.isNotEmpty()) out.add(context.getString(R.string.for_recipes, recipes.joinToString(", ")))
        return out.joinToString("\n")
    }

    private fun productName(p: ListState.Product) = listOf(p.brand, p.name).filter { it.isNotBlank() }.joinToString(" ")

    private fun shortStore(store: String) = if (store == "Albert Heijn") "AH" else store
}
