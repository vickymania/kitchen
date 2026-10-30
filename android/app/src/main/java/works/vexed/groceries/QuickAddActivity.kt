package works.vexed.groceries

import android.app.Activity
import android.content.Intent
import android.graphics.Typeface
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Bundle
import android.text.Editable
import android.text.TextWatcher
import android.util.TypedValue
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView

/**
 * The dialog behind the widget: a field with the keyboard open. Each line goes
 * into the queue (AddWorker) and the field empties for the next one; back or a
 * tap outside closes it. The server reads "2 ui" the same way as the add box.
 * 1.6: while typing, up to four known items (Suggest.kt, offline from the
 * names fetched once a day); a tap adds a line of exactly that item. Send
 * without a tap adds the text: the server links an exact name or other name
 * itself, anything else becomes a new item.
 */
class QuickAddActivity : Activity() {
    private val lines = ArrayList<String>()
    private var names: List<Suggest.Name> = emptyList()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (!TokenStore(this).isLinked()) {
            startActivity(Intent(this, MainActivity::class.java))
            finish()
            return
        }
        setContentView(R.layout.activity_quick_add)
        window.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_VISIBLE)

        val text = findViewById<EditText>(R.id.text)
        text.setOnEditorActionListener { _, action, event ->
            val enter = event?.keyCode == KeyEvent.KEYCODE_ENTER && event.action == KeyEvent.ACTION_DOWN
            if (action == EditorInfo.IME_ACTION_SEND || action == EditorInfo.IME_ACTION_DONE || enter) submit(text)
            true
        }
        findViewById<View>(R.id.add).setOnClickListener { submit(text) }
        names = Suggest.names(this)
        text.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
            override fun afterTextChanged(s: Editable?) = showSuggestions(text)
        })
        // No names yet, or yesterday's: fetch them now, quietly (offline: the old ones stay).
        if (Suggest.stale(this)) {
            val token = TokenStore(this).load()
            if (token != null) Thread {
                runCatching { Suggest.refreshIfStale(applicationContext, token) }
                runOnUiThread {
                    if (!isFinishing) {
                        names = Suggest.names(this)
                        showSuggestions(text)
                    }
                }
            }.start()
        }
        text.requestFocus()
        text.post { text.windowInsetsController?.show(WindowInsets.Type.ime()) }
    }

    private fun showSuggestions(field: EditText) {
        val box = findViewById<LinearLayout>(R.id.suggest)
        box.removeAllViews()
        val hits = Suggest.suggest(names, Suggest.namePart(field.text.toString()))
        box.visibility = if (hits.isEmpty()) View.GONE else View.VISIBLE
        val dp = resources.displayMetrics.density
        for (hit in hits) {
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                minimumHeight = (48 * dp).toInt()
                gravity = Gravity.CENTER_VERTICAL
                setPadding((12 * dp).toInt(), (8 * dp).toInt(), (12 * dp).toInt(), (8 * dp).toInt())
                setBackgroundResource(R.drawable.button_outline)
                isClickable = true
                isFocusable = true
                contentDescription = hit.name.name
                setOnClickListener { pick(field, hit.name) }
            }
            row.addView(TextView(this).apply {
                text = hit.name.name.uppercase()
                setTextColor(getColor(R.color.ink))
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
                setTypeface(typeface, Typeface.BOLD)
            })
            val grey = listOfNotNull(hit.via?.let { getString(R.string.quick_also, it) }, hit.name.product).joinToString(" · ")
            if (grey.isNotEmpty()) row.addView(TextView(this).apply {
                text = grey
                setTextColor(getColor(if (hit.via != null) R.color.signal else R.color.mute))
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
                typeface = Typeface.MONOSPACE
            })
            box.addView(row, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
                .apply { topMargin = (4 * dp).toInt() })
        }
    }

    /** A tapped suggestion: a line of exactly that item, the amount from what was typed. */
    private fun pick(field: EditText, name: Suggest.Name) {
        val typed = field.text.toString().replace(Regex("\\s+"), " ").trim()
        AddWorker.enqueue(this, typed.ifEmpty { name.name }, name.id, name.name)
        added(field, name.name)
    }

    private fun submit(field: EditText) {
        val line = field.text.toString().replace(Regex("\\s+"), " ").trim()
        if (line.isEmpty()) return
        AddWorker.enqueue(this, line)
        added(field, line)
    }

    private fun added(field: EditText, line: String) {
        lines.add(0, line)
        findViewById<TextView>(R.id.added).apply {
            text = lines.joinToString("\n") { getString(R.string.quick_added, it) }
            visibility = View.VISIBLE
        }
        findViewById<View>(R.id.offline).visibility = if (isOnline()) View.GONE else View.VISIBLE
        field.setText("")
    }

    private fun isOnline(): Boolean {
        val cm = getSystemService(ConnectivityManager::class.java)
        val caps = cm.getNetworkCapabilities(cm.activeNetwork) ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }
}
