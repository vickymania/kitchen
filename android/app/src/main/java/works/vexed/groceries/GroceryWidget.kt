package works.vexed.groceries

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.style.ForegroundColorSpan
import android.text.style.RelativeSizeSpan
import android.view.View
import android.widget.RemoteViews

/**
 * The home-screen widget: the count and the open lines per store (AH, Dirk,
 * other stores, anywhere), with where to buy each one and an offer tag. Only
 * the circle ticks a line off (28-10-2026); a tap on the rest of the
 * line opens its details in place, a second tap closes them. Drawing it never
 * touches the network: it shows what ListState holds.
 */
class GroceryWidget : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        manager.updateAppWidget(ids, render(context))
    }

    override fun onEnabled(context: Context) {
        RefreshWorker.schedule(context)
    }

    override fun onDisabled(context: Context) {
        RefreshWorker.cancel(context)
    }

    override fun onReceive(context: Context, intent: Intent) {
        val entry = intent.getStringExtra(EXTRA_ENTRY)
        when (intent.action) {
            ACTION_LINE -> when (intent.getStringExtra(EXTRA_WHAT)) {
                WHAT_TICK -> entry?.let {
                    ListState.markTicked(context, it)
                    updateAll(context)
                    CheckWorker.enqueue(context, it)
                }
                // The × (1.6): off the list, hidden at once like a tick.
                WHAT_REMOVE -> entry?.let {
                    ListState.markTicked(context, it)
                    updateAll(context)
                    CheckWorker.enqueue(context, it, remove = true)
                }
                WHAT_TOGGLE -> entry?.let {
                    ListState.toggleExpanded(context, it)
                    updateAll(context)
                }
                WHAT_OPEN -> entry?.let { context.startActivity(webApp(context, "#/entry/$it")) }
                // entry is the row's key here.
                WHAT_NOT_YET -> entry?.let { key ->
                    ListState.notYetOp(context, key)?.let { op ->
                        ListState.markNotYet(context, key)
                        updateAll(context)
                        SoonOpsWorker.notYet(context, key, op)
                    }
                }
                // The "Al nodig?" row's circle (1.5): straight into the basket, like a ticked line.
                WHAT_SOON_TICK -> entry?.let { key ->
                    ListState.tickEntry(context, key)?.let { line ->
                        ListState.markNotYet(context, key)
                        updateAll(context)
                        SoonOpsWorker.tick(context, key, line)
                    }
                }
            }
            ACTION_REFRESH -> RefreshWorker.now(context)
            else -> super.onReceive(context, intent)
        }
    }

    companion object {
        private const val ACTION_LINE = "works.vexed.groceries.LINE"
        private const val ACTION_REFRESH = "works.vexed.groceries.REFRESH"
        private const val EXTRA_ENTRY = "entry"
        private const val EXTRA_WHAT = "what"
        private const val WHAT_TICK = "tick"
        private const val WHAT_TOGGLE = "toggle"
        private const val WHAT_REMOVE = "remove"
        private const val WHAT_OPEN = "open"
        private const val WHAT_NOT_YET = "not_yet"
        private const val WHAT_SOON_TICK = "soon_tick"

        fun updateAll(context: Context) {
            val manager = AppWidgetManager.getInstance(context)
            val ids = manager.getAppWidgetIds(ComponentName(context, GroceryWidget::class.java))
            if (ids.isNotEmpty()) manager.updateAppWidget(ids, render(context))
        }

        private fun render(context: Context): RemoteViews {
            val views = RemoteViews(context.packageName, R.layout.widget)
            val linked = TokenStore(context).isLinked()
            val groups = if (linked) ListState.groups(context) else null
            val count = groups?.sumOf { it.lines.size }
            views.setTextViewText(R.id.count, when {
                !linked -> context.getString(R.string.widget_unpaired)
                count == null -> "—"
                else -> countText(context, count)
            })

            val items = RemoteViews.RemoteCollectionItems.Builder().setHasStableIds(true).setViewTypeCount(3)
            groups.orEmpty().forEach { group ->
                val heading = RemoteViews(context.packageName, R.layout.widget_group)
                heading.setTextViewText(R.id.group, group.store ?: context.getString(R.string.group_anywhere))
                items.addItem("group:${group.store}".hashCode().toLong(), heading)
                group.lines.forEach { line -> items.addItem(line.id.hashCode().toLong(), lineRow(context, line)) }
            }
            // "Al nodig?" under the list (1.4): a hint with what is left and "Nog niet".
            val soon = if (linked) ListState.neededSoon(context) else emptyList()
            if (soon.isNotEmpty()) {
                if (count == 0) items.addItem("empty".hashCode().toLong(), soonRow(context, context.getString(R.string.widget_empty), "", null, null))
                val heading = RemoteViews(context.packageName, R.layout.widget_group)
                heading.setTextViewText(R.id.group, context.getString(R.string.soon_title))
                heading.setTextColor(R.id.group, context.getColor(R.color.mute))
                items.addItem("group:soon".hashCode().toLong(), heading)
                soon.forEach { s ->
                    items.addItem("soon:${s.key}".hashCode().toLong(),
                        soonRow(context, s.name, SoonText.of(context, s), s.key.takeIf { s.notYet != null }, s.key.takeIf { s.tick != null }))
                }
            }
            views.setRemoteAdapter(R.id.lines, items.build())
            views.setViewVisibility(R.id.empty, if (linked && count == 0 && soon.isEmpty()) View.VISIBLE else View.GONE)

            // Mutable: each part of a row fills in its entry id and what the tap does.
            val line = Intent(context, GroceryWidget::class.java).setAction(ACTION_LINE)
            views.setPendingIntentTemplate(R.id.lines,
                PendingIntent.getBroadcast(context, 2, line, PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
            val refresh = Intent(context, GroceryWidget::class.java).setAction(ACTION_REFRESH)
            views.setOnClickPendingIntent(R.id.refresh,
                PendingIntent.getBroadcast(context, 3, refresh, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))

            val target = Intent(context, if (linked) QuickAddActivity::class.java else MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            val add = PendingIntent.getActivity(context, 0, target, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
            views.setOnClickPendingIntent(R.id.add_area, add)
            views.setOnClickPendingIntent(R.id.add_button, add)
            val open = PendingIntent.getActivity(context, 1, webApp(context), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
            views.setOnClickPendingIntent(R.id.open_list, open)
            return views
        }

        private fun lineRow(context: Context, line: ListState.Line): RemoteViews {
            val row = RemoteViews(context.packageName, R.layout.widget_line)
            row.setTextViewText(R.id.title, line.title)
            row.setTextViewText(R.id.amount, Amounts.format(context, line.amounts))
            val expanded = ListState.isExpanded(context, line.id)
            val sub = if (expanded) "" else LineText.short(context, line)
            row.setTextViewText(R.id.sub, sub)
            row.setViewVisibility(R.id.sub, if (sub.isEmpty()) View.GONE else View.VISIBLE)
            val details = if (expanded) LineText.details(context, line) else ""
            row.setTextViewText(R.id.details, details)
            row.setViewVisibility(R.id.details, if (details.isEmpty()) View.GONE else View.VISIBLE)
            row.setViewVisibility(R.id.open_entry, if (expanded) View.VISIBLE else View.GONE)
            row.setOnClickFillInIntent(R.id.tick, tap(line.id, WHAT_TICK))
            row.setOnClickFillInIntent(R.id.body, tap(line.id, WHAT_TOGGLE))
            row.setOnClickFillInIntent(R.id.remove, tap(line.id, WHAT_REMOVE))
            row.setOnClickFillInIntent(R.id.open_entry, tap(line.id, WHAT_OPEN))
            return row
        }

        /** notYetKey / tickKey null: no "Nog niet" / no circle (the "nothing on the list" row). */
        private fun soonRow(context: Context, name: String, left: String, notYetKey: String?, tickKey: String?): RemoteViews {
            val row = RemoteViews(context.packageName, R.layout.widget_soon)
            row.setTextViewText(R.id.soon_name, name)
            row.setTextViewText(R.id.soon_left, left)
            row.setViewVisibility(R.id.soon_not_yet, if (notYetKey == null) View.GONE else View.VISIBLE)
            if (notYetKey != null) row.setOnClickFillInIntent(R.id.soon_not_yet, tap(notYetKey, WHAT_NOT_YET))
            // Without a circle the 52dp column stays, so the text lines up with the list's lines.
            row.setViewVisibility(R.id.soon_tick, if (tickKey == null) View.INVISIBLE else View.VISIBLE)
            if (tickKey != null) row.setOnClickFillInIntent(R.id.soon_tick, tap(tickKey, WHAT_SOON_TICK))
            return row
        }

        private fun tap(entry: String, what: String) = Intent().putExtra(EXTRA_ENTRY, entry).putExtra(EXTRA_WHAT, what)

        /** "7. open" with the red dot of the vexed.works titles. */
        private fun countText(context: Context, count: Int): CharSequence {
            val text = SpannableStringBuilder(count.toString())
            val dot = text.length
            text.append(".")
            text.setSpan(ForegroundColorSpan(context.getColor(R.color.signal)), dot, dot + 1, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            val word = text.length
            text.append(" ").append(context.getString(R.string.widget_open))
            text.setSpan(RelativeSizeSpan(0.6f), word, text.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            return text
        }

        /**
         * The installed Groceries web app (a Chrome WebAPK) when there is one,
         * else the browser. fragment: "#/entry/<id>" opens that line there.
         */
        fun webApp(context: Context, fragment: String = ""): Intent {
            val probe = Intent(Intent.ACTION_VIEW, Uri.parse("${Api.ORIGIN}/")).addCategory(Intent.CATEGORY_BROWSABLE)
            val intent = Intent(Intent.ACTION_VIEW, Uri.parse("${Api.ORIGIN}/$fragment"))
                .addCategory(Intent.CATEGORY_BROWSABLE)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.packageManager.queryIntentActivities(probe, PackageManager.MATCH_ALL)
                .firstOrNull { it.activityInfo.packageName.startsWith("org.chromium.webapk") }
                ?.let { intent.setPackage(it.activityInfo.packageName) }
            return intent
        }
    }
}
