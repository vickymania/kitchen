plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "works.vexed.groceries"
    compileSdk = 35

    defaultConfig {
        applicationId = "works.vexed.groceries"
        minSdk = 31
        targetSdk = 34
        versionCode = 7
        versionName = "1.6.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            // Sideloaded only, never on the Play Store: the debug key of this
            // computer signs it, so a new build installs over the old one.
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.work:work-runtime-ktx:2.9.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    // Suggest.kt against the same examples as tests/suggest.test.mjs (./gradlew testReleaseUnitTest).
    testImplementation("junit:junit:4.13.2")
}
