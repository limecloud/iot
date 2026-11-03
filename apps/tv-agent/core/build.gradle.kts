import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import groovy.json.JsonOutput

plugins { kotlin("jvm") }
kotlin {
    jvmToolchain(21)
    compilerOptions { jvmTarget.set(JvmTarget.JVM_1_8) }
}
tasks.withType<JavaCompile>().configureEach { options.release.set(8) }
dependencies {
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.9.0")
    implementation("com.fasterxml.jackson.core:jackson-core:2.18.5")
    implementation("org.eclipse.paho:org.eclipse.paho.mqttv5.client:1.2.5")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.bouncycastle:bcpkix-jdk18on:1.86")
    testImplementation(kotlin("test"))
}
dependencyLocking { lockAllConfigurations() }
tasks.processResources {
    from("../../../contracts/models/android-tv-agent.json")
    from("../../../contracts/models/android-tv-remote.json")
}
tasks.withType<Test>().configureEach {
    useJUnitPlatform()
    environment(System.getenv().filterKeys { it.startsWith("LIMEIOT_TV_AGENT_") })
}
tasks.register<Test>("mqttJourney") {
    testClassesDirs = sourceSets.test.get().output.classesDirs
    classpath = sourceSets.test.get().runtimeClasspath
    filter { includeTestsMatching("*MqttJourneyTest") }
}

// 构建完成后导出测试 JVM 入口，网络旅程不再通过 Gradle 启动设备进程。
tasks.register("journeyRuntime") {
    dependsOn(tasks.testClasses)
    doLast {
        val launcher = javaToolchains.launcherFor {
            languageVersion.set(JavaLanguageVersion.of(21))
        }.get()
        val output = layout.buildDirectory.file("journey/runtime.json").get().asFile
        output.parentFile.mkdirs()
        output.writeText(JsonOutput.toJson(mapOf(
            "java" to launcher.executablePath.asFile.absolutePath,
            "classpath" to sourceSets.test.get().runtimeClasspath.asPath,
            "main" to "run.limeai.iot.device.MqttJourneyMain",
        )))
    }
}
