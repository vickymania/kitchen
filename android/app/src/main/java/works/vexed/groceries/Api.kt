package works.vexed.groceries

import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.SecureRandom
import java.util.Base64

/**
 * The few routes of groceries.vexed.works this app uses (worker/api.js).
 * The device token goes in the Authorization header and is never logged.
 */
object Api {
    const val ORIGIN = "https://groceries.vexed.works"

    /** A non-2xx answer. 401 means this phone is no longer linked. */
    class HttpError(val status: Int, val code: String?) : IOException("HTTP $status ${code.orEmpty()}")

    /** Links this phone with a six-digit code; returns the device token from the kd cookie. */
    fun pair(code: String, label: String): String {
        val conn = open("/api/pair", "POST", token = null)
        // The route is open but checks same origin, like a browser would send.
        conn.setRequestProperty("Origin", ORIGIN)
        write(conn, JSONObject().put("code", code).put("label", label))
        read(conn)
        return conn.headerFields["Set-Cookie"].orEmpty()
            .firstNotNullOfOrNull { Regex("^kd=([^;]+)").find(it)?.groupValues?.get(1) }
            ?: throw HttpError(conn.responseCode, "no_token")
    }

    fun me(token: String): JSONObject = read(open("/api/me", "GET", token))

    /**
     * One typed line; the server parses it like the add box. The same opId on
     * retry never adds twice. A tapped suggestion (1.6) also sends its item's
     * id and name: the line is that item, the amount still comes from the text.
     */
    fun quickAdd(token: String, text: String, opId: String, itemId: String? = null, title: String? = null): JSONObject {
        val conn = open("/api/quick-add", "POST", token)
        val body = JSONObject().put("text", text).put("op_id", opId)
        if (itemId != null && title != null) body.put("item_id", itemId).put("title", title)
        write(conn, body)
        return read(conn)
    }

    /** The names the add dialog suggests from (worker/widget.js widgetNames), once a day. */
    fun widgetNames(token: String): JSONObject = read(open("/api/widget/names", "GET", token))

    /**
     * Ticks a line off (the same entry.check a tap in the web app sends), or
     * with remove (1.6, the ×) takes it off the list (entry.delete). Returns the op's result.
     */
    fun check(token: String, entryId: String, opId: String, remove: Boolean = false): JSONObject {
        val op = if (remove) JSONObject().put("op_id", opId).put("type", "entry.delete").put("id", entryId)
        else JSONObject().put("op_id", opId).put("type", "entry.check").put("id", entryId).put("checked", true)
        val conn = open("/api/ops", "POST", token)
        write(conn, JSONObject().put("ops", org.json.JSONArray().put(op)))
        return read(conn).getJSONArray("results").getJSONObject(0)
    }

    /**
     * Sends a few ops of an "Al nodig?" row (SoonOpsWorker), each with its
     * op_id already set, in one batch. Returns their results, in order.
     */
    fun ops(token: String, ops: org.json.JSONArray): org.json.JSONArray {
        val conn = open("/api/ops", "POST", token)
        write(conn, JSONObject().put("ops", ops))
        return read(conn).getJSONArray("results")
    }

    /**
     * The widget's list per store with the details per line (worker/widget.js),
     * or { rev, unchanged: true } when nothing changed after `since`.
     */
    fun widget(token: String, since: Long): JSONObject = read(open("/api/widget?since=$since", "GET", token))

    fun logout(token: String) {
        val conn = open("/api/logout", "POST", token)
        write(conn, JSONObject())
        read(conn)
    }

    private fun open(path: String, method: String, token: String?): HttpURLConnection =
        (URL(ORIGIN + path).openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = 10_000
            readTimeout = 15_000
            useCaches = false
            setRequestProperty("Accept", "application/json")
            if (token != null) setRequestProperty("Authorization", "Bearer $token")
        }

    private fun write(conn: HttpURLConnection, body: JSONObject) {
        conn.doOutput = true
        conn.setRequestProperty("Content-Type", "application/json")
        conn.outputStream.use { it.write(body.toString().toByteArray()) }
    }

    private fun read(conn: HttpURLConnection): JSONObject {
        try {
            val status = conn.responseCode
            val stream = if (status in 200..299) conn.inputStream else conn.errorStream
            val text = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
            val json = runCatching { JSONObject(text) }.getOrDefault(JSONObject())
            if (status !in 200..299) throw HttpError(status, json.optString("error").ifEmpty { null })
            return json
        } finally {
            conn.disconnect()
        }
    }
}

/** The same shape as newId() in public/app/dom.js: 12 random bytes, URL-safe base64, 16 characters. */
fun newId(): String {
    val bytes = ByteArray(12).also { SecureRandom().nextBytes(it) }
    return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
}
