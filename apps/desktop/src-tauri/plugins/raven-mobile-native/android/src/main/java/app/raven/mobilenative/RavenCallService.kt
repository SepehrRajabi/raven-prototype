package app.raven.mobilenative

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

/**
 * Foreground service that keeps the process (and so the call's audio) alive while Raven is
 * backgrounded. Only the microphone type is started: camera capture stays foreground-only,
 * and the manifest declares camera solely so a later change does not need a manifest edit.
 */
class RavenCallService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val manager = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(NotificationChannel(CHANNEL_ID, "Calls", NotificationManager.IMPORTANCE_LOW))
        }
        // The launch intent brings the existing task back instead of stacking a new Activity.
        val open = packageManager.getLaunchIntentForPackage(packageName)?.apply {
            addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
        }
        val notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(applicationInfo.icon)
            .setContentTitle("Raven call")
            .setContentText("Tap to return to the call")
            .setOngoing(true)
            .setCategory(Notification.CATEGORY_CALL)
            .setContentIntent(open?.let { PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE) })
            .build()
        try {
            ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
        } catch (error: RuntimeException) { // Start rules or a missing grant: keep a foreground-only call.
            Log.w("RavenMobileNative", "Call service could not enter the foreground", error)
            stopSelf()
        }
        return START_NOT_STICKY
    }

    /** Swipe-away from recents: the call cannot outlive its task, so end it with the service. */
    override fun onTaskRemoved(rootIntent: Intent?) {
        onTaskRemovedListener?.invoke()
        stopSelf()
    }

    companion object {
        private const val CHANNEL_ID = "calls"
        private const val NOTIFICATION_ID = 1

        /** Set by the plugin while a call holds focus and cleared on release; invoked on the main thread. */
        @Volatile var onTaskRemovedListener: (() -> Unit)? = null

        fun start(context: Context) =
            ContextCompat.startForegroundService(context, Intent(context, RavenCallService::class.java))

        fun stop(context: Context) { context.stopService(Intent(context, RavenCallService::class.java)) }
    }
}
