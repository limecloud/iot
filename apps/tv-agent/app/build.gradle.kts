import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins { id("com.android.application"); kotlin("android") }
android {
    namespace = "run.limeai.iot.television"
    compileSdk = 36
    buildToolsVersion = "36.0.0"
    defaultConfig {
        applicationId = "run.limeai.iot.television"
        minSdk = 23; targetSdk = 36; versionCode = 3; versionName = "0.3.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_1_8; targetCompatibility = JavaVersion.VERSION_1_8 }
    testOptions { unitTests.isIncludeAndroidResources = true }
    packaging.resources {
        // 保留各密码库的许可正文；Android不加载JAR内的OSGi运行清单。
        merges += "META-INF/LICENSE.md"
        excludes += "META-INF/versions/9/OSGI-INF/MANIFEST.MF"
    }
    providers.gradleProperty("limeiot.runtimeAssets").orNull?.let { sourceSets.getByName("androidTest").assets.srcDir(it) }
    buildTypes { release { isMinifyEnabled = true; proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt")) } }
}
kotlin { jvmToolchain(21); compilerOptions { jvmTarget.set(JvmTarget.JVM_1_8) } }
dependencies {
    implementation(project(":core"))
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.9.0")
    testImplementation(kotlin("test-junit"))
    testImplementation("org.robolectric:robolectric:4.16.1")
    androidTestImplementation("androidx.test:runner:1.7.0")
    androidTestImplementation("androidx.test.ext:junit:1.3.0")
}
dependencyLocking { lockAllConfigurations() }
