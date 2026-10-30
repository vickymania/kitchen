package works.vexed.groceries

import android.app.Activity
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.os.Build
import android.os.Bundle
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.style.ForegroundColorSpan
import android.view.View
import android.view.inputmethod.EditorInfo
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.IOException

/** Linking this phone with a six-digit code, and what to do once it is linked. */
class MainActivity : Activity() {
    private val scope = MainScope()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        val code = findViewById<EditText>(R.id.code)
        findViewById<Button>(R.id.pair).setOnClickListener { link(code) }
        code.setOnEditorActionListener { _, action, _ ->
            if (action == EditorInfo.IME_ACTION_DONE) link(code)
            false
        }
        findViewById<Button>(R.id.unpair).setOnClickListener { unlink() }
        findViewById<Button>(R.id.pin_widget).setOnClickListener {
            AppWidgetManager.getInstance(this).requestPinAppWidget(ComponentName(this, GroceryWidget::class.java), null, null)
        }
        render()
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    private fun render() {
        val linked = TokenStore(this).isLinked()
        findViewById<TextView>(R.id.title).text = titleText(getString(if (linked) R.string.paired_title else R.string.pair_title))
        findViewById<View>(R.id.pair_section).visibility = if (linked) View.GONE else View.VISIBLE
        findViewById<View>(R.id.paired_section).visibility = if (linked) View.VISIBLE else View.GONE
        findViewById<TextView>(R.id.paired_as).text =
            ListState.memberLine(this)?.let { (member, household) -> getString(R.string.paired_as, member, household) }.orEmpty()
        findViewById<View>(R.id.pin_widget).visibility =
            if (AppWidgetManager.getInstance(this).isRequestPinAppWidgetSupported) View.VISIBLE else View.GONE
    }

    private fun link(field: EditText) {
        val code = field.text.toString().filter { it.isDigit() }
        val error = findViewById<TextView>(R.id.pair_error)
        if (code.length != 6) return
        val button = findViewById<Button>(R.id.pair).apply { isEnabled = false }
        error.visibility = View.GONE
        scope.launch {
            try {
                withContext(Dispatchers.IO) {
                    val token = Api.pair(code, getString(R.string.pair_label, Build.MODEL))
                    TokenStore(this@MainActivity).save(token)
                    ListState.clear(this@MainActivity)
                    runCatching {
                        val me = Api.me(token)
                        ListState.saveMember(
                            this@MainActivity,
                            me.getJSONObject("member").optString("name"),
                            me.optJSONObject("household")?.optString("name").orEmpty(),
                        )
                    }
                }
                RefreshWorker.now(this@MainActivity)
                GroceryWidget.updateAll(this@MainActivity)
                field.setText("")
                render()
            } catch (e: Api.HttpError) {
                error.text = getString(if (e.status == 429) R.string.pair_too_many else R.string.pair_wrong_code)
                error.visibility = View.VISIBLE
            } catch (e: IOException) {
                error.text = getString(R.string.pair_offline)
                error.visibility = View.VISIBLE
            } finally {
                button.isEnabled = true
            }
        }
    }

    private fun unlink() {
        val token = TokenStore(this).load()
        scope.launch {
            // Revoke the device on the server too; offline it is only forgotten here.
            if (token != null) withContext(Dispatchers.IO) { runCatching { Api.logout(token) } }
            Linking.forget(this@MainActivity)
            render()
        }
    }

    /** "KOPPEL." with the red dot of the vexed.works titles. */
    private fun titleText(word: String): CharSequence {
        val text = SpannableStringBuilder(word).append(".")
        text.setSpan(ForegroundColorSpan(getColor(R.color.signal)), word.length, word.length + 1, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        return text
    }
}
