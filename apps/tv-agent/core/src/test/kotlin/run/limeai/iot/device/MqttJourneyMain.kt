package run.limeai.iot.device

/** 独立设备 JVM 复用同一旅程与断言；异常直接以非零状态退出。 */
object MqttJourneyMain {
    @JvmStatic fun main(args: Array<String>) {
        MqttJourneyTest().actual_mtls_protocol_device_journal_and_process_restart()
    }
}
