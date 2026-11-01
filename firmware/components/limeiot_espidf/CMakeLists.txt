idf_component_register(SRCS "src/espidf.c" INCLUDE_DIRS "include" REQUIRES limeiot_core PRIV_REQUIRES esp_timer esp_event esp_system esp_hw_support nvs_flash mbedtls espressif__mqtt)
