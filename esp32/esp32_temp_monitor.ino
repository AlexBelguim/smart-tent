/**
 * ESP32 Temperature Monitor for Smart Tent Dashboard
 * 
 * Features:
 * - DS18B20 temperature sensor support (multiple sensors on one bus)
 * - HTTP API for remote monitoring
 * - Sensor detection and naming
 * - Names stored in NVS (Non-Volatile Storage)
 */

#include <WiFi.h>
#include <WebServer.h>
#include <Preferences.h>
#include <ArduinoJson.h>
#include <OneWire.h>
#include <DallasTemperature.h>

// ============== CONFIGURATION ==============
// WiFi credentials - CHANGE THESE
const char* WIFI_SSID = "DirtHut";
const char* WIFI_PASSWORD = "IchurakuStand3";

// OneWire Configuration
const int ONE_WIRE_BUS = 22;  // GPIO pin for OneWire bus (configurable)

// Server port
const int SERVER_PORT = 80;

// ============== GLOBALS ==============
WebServer server(SERVER_PORT);
Preferences preferences;

// OneWire and DallasTemperature setup
OneWire oneWire(ONE_WIRE_BUS);
DallasTemperature sensors(&oneWire);

// Sensor data cache
struct SensorData {
  uint8_t address[8];
  char addressStr[17];  // Hex string representation
  char name[32];
  float tempC;
  bool valid;
};

const int MAX_SENSORS = 10;
SensorData sensorCache[MAX_SENSORS];
int sensorCount = 0;
unsigned long lastReadTime = 0;
const unsigned long READ_INTERVAL = 2000;  // Read every 2 seconds

// ============== HELPER FUNCTIONS ==============

void addressToString(uint8_t* addr, char* str) {
  sprintf(str, "%02X%02X%02X%02X%02X%02X%02X%02X",
    addr[0], addr[1], addr[2], addr[3], 
    addr[4], addr[5], addr[6], addr[7]);
}

void loadSensorNames() {
  preferences.begin("temp_names", true);  // Read-only
  for (int i = 0; i < sensorCount; i++) {
    String key = String(sensorCache[i].addressStr);
    String name = preferences.getString(key.c_str(), "");
    if (name.length() > 0) {
      strncpy(sensorCache[i].name, name.c_str(), sizeof(sensorCache[i].name) - 1);
    } else {
      sprintf(sensorCache[i].name, "Sensor %d", i + 1);
    }
  }
  preferences.end();
}

void saveSensorName(const char* address, const char* name) {
  preferences.begin("temp_names", false);  // Read-write
  preferences.putString(address, name);
  preferences.end();
  Serial.printf("[NAME] Saved: %s = %s\n", address, name);
}

void detectSensors() {
  sensorCount = 0;
  sensors.begin();
  
  int deviceCount = sensors.getDeviceCount();
  Serial.printf("[DETECT] Found %d devices\n", deviceCount);
  
  for (int i = 0; i < deviceCount && i < MAX_SENSORS; i++) {
    if (sensors.getAddress(sensorCache[i].address, i)) {
      addressToString(sensorCache[i].address, sensorCache[i].addressStr);
      sensorCache[i].tempC = -127.0;
      sensorCache[i].valid = false;
      sensorCount++;
    }
  }
  
  loadSensorNames();
}

void readSensors() {
  sensors.requestTemperatures();
  
  for (int i = 0; i < sensorCount; i++) {
    float temp = sensors.getTempC(sensorCache[i].address);
    
    if (temp != DEVICE_DISCONNECTED_C && temp != -127.0) {
      sensorCache[i].tempC = temp;
      sensorCache[i].valid = true;
    } else {
      sensorCache[i].valid = false;
    }
  }
}

// ============== HTTP HANDLERS ==============

void handleCORS() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  server.sendHeader("Access-Control-Allow-Headers", "Content-Type");
}

void handleOptions() {
  handleCORS();
  server.send(204);
}

void handleStatus() {
  handleCORS();
  
  StaticJsonDocument<2048> doc;
  doc["available"] = true;
  doc["device"] = "ESP32 Temperature Monitor";
  doc["sensor_count"] = sensorCount;
  doc["ip"] = WiFi.localIP().toString();
  
  JsonArray sensorsArray = doc.createNestedArray("sensors");
  for (int i = 0; i < sensorCount; i++) {
    JsonObject sensor = sensorsArray.createNestedObject();
    sensor["address"] = sensorCache[i].addressStr;
    sensor["name"] = sensorCache[i].name;
    sensor["temp_c"] = sensorCache[i].valid ? sensorCache[i].tempC : nullptr;
    sensor["valid"] = sensorCache[i].valid;
  }
  
  String response;
  serializeJson(doc, response);
  server.send(200, "application/json", response);
}

void handleDetect() {
  handleCORS();
  
  Serial.println("[API] Detecting sensors...");
  detectSensors();
  
  StaticJsonDocument<1024> doc;
  JsonArray sensorsArray = doc.createNestedArray("sensors");
  
  for (int i = 0; i < sensorCount; i++) {
    JsonObject sensor = sensorsArray.createNestedObject();
    sensor["address"] = sensorCache[i].addressStr;
    sensor["name"] = sensorCache[i].name;
  }
  
  String response;
  serializeJson(doc, response);
  server.send(200, "application/json", response);
}

void handleSetName() {
  handleCORS();
  
  if (!server.hasArg("plain")) {
    server.send(400, "application/json", "{\"error\":\"No body\"}");
    return;
  }
  
  StaticJsonDocument<256> doc;
  DeserializationError error = deserializeJson(doc, server.arg("plain"));
  
  if (error) {
    server.send(400, "application/json", "{\"error\":\"Invalid JSON\"}");
    return;
  }
  
  if (!doc.containsKey("address") || !doc.containsKey("name")) {
    server.send(400, "application/json", "{\"error\":\"Missing address or name\"}");
    return;
  }
  
  String address = doc["address"].as<String>();
  String name = doc["name"].as<String>();
  
  // Save to NVS
  saveSensorName(address.c_str(), name.c_str());
  
  // Update cache
  for (int i = 0; i < sensorCount; i++) {
    if (strcmp(sensorCache[i].addressStr, address.c_str()) == 0) {
      strncpy(sensorCache[i].name, name.c_str(), sizeof(sensorCache[i].name) - 1);
      break;
    }
  }
  
  server.send(200, "application/json", "{\"success\":true}");
}

// ============== SETUP & LOOP ==============

void setup() {
  Serial.begin(115200);
  Serial.println("\n=================================");
  Serial.println("ESP32 Temperature Monitor");
  Serial.println("=================================");
  
  // Initialize OneWire
  Serial.printf("[OneWire] Initialized on GPIO %d\n", ONE_WIRE_BUS);
  
  // Detect sensors
  detectSensors();
  Serial.printf("[SENSORS] Detected %d sensors\n", sensorCount);
  
  // Connect to WiFi
  Serial.printf("[WIFI] Connecting to %s", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.disconnect();
  delay(100);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  
  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 30) {
    delay(500);
    Serial.print(".");
    attempts++;
  }
  
  if (WiFi.status() == WL_CONNECTED) {
    Serial.println(" Connected!");
    Serial.printf("[WIFI] IP Address: %s\n", WiFi.localIP().toString().c_str());
  } else {
    Serial.println(" FAILED!");
    Serial.println("[WIFI] Running in offline mode");
  }
  
  // Setup HTTP routes
  server.on("/status", HTTP_GET, handleStatus);
  server.on("/status", HTTP_OPTIONS, handleOptions);
  
  server.on("/detect", HTTP_GET, handleDetect);
  server.on("/detect", HTTP_OPTIONS, handleOptions);
  
  server.on("/name", HTTP_POST, handleSetName);
  server.on("/name", HTTP_OPTIONS, handleOptions);
  
  server.begin();
  Serial.printf("[HTTP] Server started on port %d\n", SERVER_PORT);
  Serial.println("=================================\n");
}

void loop() {
  server.handleClient();
  
  // Read sensors periodically
  if (millis() - lastReadTime >= READ_INTERVAL) {
    lastReadTime = millis();
    readSensors();
  }
  
  // Reconnect WiFi if disconnected
  if (WiFi.status() != WL_CONNECTED) {
    static unsigned long lastReconnectAttempt = 0;
    if (millis() - lastReconnectAttempt >= 30000) {
      lastReconnectAttempt = millis();
      Serial.println("[WIFI] Attempting reconnection...");
      WiFi.reconnect();
    }
  }
  
  delay(10);  // Small delay to prevent watchdog issues
}
