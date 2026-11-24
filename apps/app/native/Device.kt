import android.os.Build
import dev.onejs.one.source.OneModule

// each function is an async function in typescript: `await Device.info()`.
// one generates Device.d.kt.ts from these signatures.
object Device : OneModule {
    fun info(): Map<String, String> = mapOf(
        "language" to "Kotlin",
        "model" to Build.MODEL,
        "system" to "Android ${Build.VERSION.RELEASE}",
    )
}
