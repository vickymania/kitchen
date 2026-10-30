package works.vexed.groceries

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

private val online = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

/**
 * Sends one typed line. Queued, so it waits for a connection; the op_id is
 * chosen once when the line is queued and travels unchanged with every retry,
 * so the server never adds it twice.
 */
class AddWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val token = TokenStore(applicationContext).load() ?: return Result.failure()
        val text = inputData.getString(KEY_TEXT) ?: return Result.failure()
        val opId = inputData.getString(KEY_OP_ID) ?: return Result.failure()
        try {
            Api.quickAdd(token, text, opId, inputData.getString(KEY_ITEM), inputData.getString(KEY_TITLE))
        } catch (e: Api.HttpError) {
            return when {
                e.status == 401 -> Linking.forget(applicationContext).let { Result.failure() }
                e.status >= 500 || e.status == 429 -> Result.retry()
                else -> Result.failure()
            }
        } catch (e: IOException) {
            return Result.retry()
        }
        refreshQuietly(applicationContext, token)
        return Result.success()
    }

    companion object {
        private const val KEY_TEXT = "text"
        private const val KEY_OP_ID = "op_id"
        private const val KEY_ITEM = "item_id"
        private const val KEY_TITLE = "title"

        /** itemId and title: a tapped suggestion (1.6), the line is that item. */
        fun enqueue(context: Context, text: String, itemId: String? = null, title: String? = null) {
            val opId = newId()
            val request = OneTimeWorkRequestBuilder<AddWorker>()
                .setInputData(workDataOf(KEY_TEXT to text, KEY_OP_ID to opId, KEY_ITEM to itemId, KEY_TITLE to title))
                .setConstraints(online)
                .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 15, TimeUnit.SECONDS)
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork("add-$opId", ExistingWorkPolicy.KEEP, request)
        }
    }
}

/**
 * Sends one tick (or, 1.6, one × as entry.delete) from the widget. The line is hidden at once (ListState.markTicked);
 * like AddWorker it waits for a connection and keeps its op_id on retries.
 */
class CheckWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val token = TokenStore(applicationContext).load() ?: return Result.failure()
        val entryId = inputData.getString(KEY_ENTRY) ?: return Result.failure()
        val opId = inputData.getString(KEY_OP_ID) ?: return Result.failure()
        try {
            val result = Api.check(token, entryId, opId, inputData.getBoolean(KEY_REMOVE, false))
            // Refused (the line was deleted elsewhere): stop hiding it, the refresh decides.
            if (!result.optBoolean("ok")) ListState.unmarkTicked(applicationContext, entryId)
        } catch (e: Api.HttpError) {
            return when {
                e.status == 401 -> Linking.forget(applicationContext).let { Result.failure() }
                e.status >= 500 || e.status == 429 -> Result.retry()
                else -> ListState.unmarkTicked(applicationContext, entryId).let { Result.failure() }
            }
        } catch (e: IOException) {
            return Result.retry()
        }
        refreshQuietly(applicationContext, token)
        return Result.success()
    }

    companion object {
        private const val KEY_ENTRY = "entry"
        private const val KEY_OP_ID = "op_id"
        private const val KEY_REMOVE = "remove"

        /** remove (1.6, the ×): entry.delete instead of a tick. */
        fun enqueue(context: Context, entryId: String, remove: Boolean = false) {
            val request = OneTimeWorkRequestBuilder<CheckWorker>()
                .setInputData(workDataOf(KEY_ENTRY to entryId, KEY_OP_ID to newId(), KEY_REMOVE to remove))
                .setConstraints(online)
                .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 15, TimeUnit.SECONDS)
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork("check-$entryId", ExistingWorkPolicy.KEEP, request)
        }
    }
}

/**
 * Sends what a tap on an "Al nodig?" row does (1.4 "Nog niet", 1.5 the tick
 * box): a few ops in one /api/ops batch, the row hidden at once
 * (ListState.markNotYet). Every op_id and new id is chosen once when the tap
 * is queued and travels unchanged with every retry, and one job per row and
 * kind is kept (KEEP), so a double tap or a retry never adds twice.
 */
class SoonOpsWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val token = TokenStore(applicationContext).load() ?: return Result.failure()
        val key = inputData.getString(KEY_KEY) ?: return Result.failure()
        val ops = inputData.getString(KEY_OPS)?.let { runCatching { org.json.JSONArray(it) }.getOrNull() } ?: return Result.failure()
        try {
            val results = Api.ops(token, ops)
            val allOk = (0 until results.length()).all { results.getJSONObject(it).optBoolean("ok") }
            if (!allOk) ListState.unmarkNotYet(applicationContext, key)
        } catch (e: Api.HttpError) {
            return when {
                e.status == 401 -> Linking.forget(applicationContext).let { Result.failure() }
                e.status >= 500 || e.status == 429 -> Result.retry()
                else -> ListState.unmarkNotYet(applicationContext, key).let { Result.failure() }
            }
        } catch (e: IOException) {
            return Result.retry()
        }
        refreshQuietly(applicationContext, token)
        return Result.success()
    }

    companion object {
        private const val KEY_KEY = "key"
        private const val KEY_OPS = "ops"

        /** "Nog niet": the op the server made for the row, with an op_id. */
        fun notYet(context: Context, key: String, op: org.json.JSONObject) =
            enqueue(context, "not-yet", key, org.json.JSONArray().put(JSONObject(op.toString()).put("op_id", newId())))

        /**
         * The tick box (1.5): one new line ticked into the basket, as tickOps in
         * public/shared/needed-soon.js makes it: entry.add + entry.check.
         */
        fun tick(context: Context, key: String, entry: JSONObject) {
            val id = newId()
            val add = JSONObject().put("op_id", newId()).put("type", "entry.add").put("id", id).put("item_id", newId())
                .put("title", entry.optString("title"))
            entry.optJSONArray("amounts")?.takeIf { it.length() > 0 }?.let { add.put("amounts", it) }
            val check = JSONObject().put("op_id", newId()).put("type", "entry.check").put("id", id).put("checked", true)
            enqueue(context, "tick", key, org.json.JSONArray().put(add).put(check))
        }

        private fun enqueue(context: Context, kind: String, key: String, ops: org.json.JSONArray) {
            val request = OneTimeWorkRequestBuilder<SoonOpsWorker>()
                .setInputData(workDataOf(KEY_KEY to key, KEY_OPS to ops.toString()))
                .setConstraints(online)
                .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 15, TimeUnit.SECONDS)
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork("soon-$kind-$key", ExistingWorkPolicy.KEEP, request)
        }
    }
}

/**
 * Keeps the widget's list fresh: at most every 30 minutes while a widget is
 * on the home screen (Thomas's Cloudflare budget), plus once after linking.
 * An idle delta poll costs the server one counter read.
 */
class RefreshWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val token = TokenStore(applicationContext).load() ?: return Result.success()
        refreshQuietly(applicationContext, token)
        return Result.success()
    }

    companion object {
        private const val PERIODIC = "refresh"
        private const val NOW = "refresh-now"

        fun schedule(context: Context) {
            val request = PeriodicWorkRequestBuilder<RefreshWorker>(30, TimeUnit.MINUTES).setConstraints(online).build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.KEEP, request)
        }

        fun cancel(context: Context) {
            WorkManager.getInstance(context).cancelUniqueWork(PERIODIC)
        }

        /**
         * The refresh button. Expedited like AddWorker: plain one-time work may
         * wait hours in a rarely used app's standby bucket, so a tap did nothing
         * until an add ran a refresh of its own (28-10-2026).
         */
        fun now(context: Context) {
            val request = OneTimeWorkRequestBuilder<RefreshWorker>()
                .setConstraints(online)
                .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork(NOW, ExistingWorkPolicy.REPLACE, request)
        }
    }
}

/** A failed count refresh never fails the add; a 401 unlinks. The suggestion names come along once a day. */
private suspend fun refreshQuietly(context: Context, token: String) {
    try {
        ListState.refresh(context, token)
        Suggest.refreshIfStale(context, token)
    } catch (e: Api.HttpError) {
        if (e.status == 401) Linking.forget(context)
    } catch (_: IOException) {
    } catch (_: org.json.JSONException) {
    }
    GroceryWidget.updateAll(context)
}

object Linking {
    /** This phone is no longer linked (signed out here, or revoked in Settings). */
    fun forget(context: Context) {
        TokenStore(context).clear()
        ListState.clear(context)
        Suggest.clear(context)
        GroceryWidget.updateAll(context)
    }
}
