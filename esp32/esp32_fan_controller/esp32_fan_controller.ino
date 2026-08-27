/**
 * ESP32 Smart Tent Controller
 * 
 * Features:
 * - PWM Fan Control
 * - DS18B20 Temperature Monitoring
 * - HTTP API for remote control
 * - Schedule storage in NVS (Non-Volatile Storage)
 * - Secure authentication via SHA-256 hashed codes
 * 
 * Security: The access code is NEVER transmitted in plain text.
 * The backend sends a SHA-256 hash, which is compared against the stored hash.
 */

#include <WiFi.h>
#include <WebServer.h>
#include <Preferences.h>
#include <ArduinoJson.h>
#include <mbedtls/sha256.h>
#include <time.h>
#include <OneWire.h>
#include <DallasTemperature.h>

// ============== CONFIGURATION ==============
// WiFi credentials - CHANGE THESE
const char* WIFI_SSID = "DirtHut";
const char* WIFI_PASSWORD = "IchurakuStand3";

// PWM Fan Configuration
const int MAX_FANS = 4;               // Maximum number of fans
int FAN_PINS[MAX_FANS] = {15, 0, 0, 0}; // GPIO pins for fans (loaded from NVS, default: GPIO 15)
int fanCount = 1;                     // Number of active fans (loaded from NVS)
const int PWM_FREQ = 25000;           // 25kHz - standard for 4-pin PWM fans
const int PWM_RESOLUTION = 8;         // 8-bit resolution (0-255)

// Temperature Sensor Configuration
int ONE_WIRE_BUS = 22;                // GPIO pin for OneWire bus (loaded from NVS, default: 22)
const int MAX_SENSORS = 10;

// Server port
const int SERVER_PORT = 80;

// Access code - stored as SHA-256 hash
// Default: "4444" -> SHA256 hash stored below
// To change the code, update this hash (use an online SHA-256 generator)
const char* AUTH_CODE_HASH = "79f06f8fde333461739f220090a23cb2a79f6d714bee100d0e4b4af249294619";

// NTP Server for time sync
const char* NTP_SERVER = "pool.ntp.org";
const long GMT_OFFSET_SEC = 3600;     // UTC+1 (adjust for your timezone)
const int DAYLIGHT_OFFSET_SEC = 0;

// ============== GLOBALS ==============
WebServer server(SERVER_PORT);
Preferences preferences;

// Fan state
int currentSpeed = 0;        // 0-100%
bool fanEnabled = true;

// Schedule structure (max 10 entries)
struct ScheduleEntry {
  bool enabled;
  uint8_t hour;      // 0-23
  uint8_t minute;    // 0-59
  uint8_t speed;     // 0-100
};

const int MAX_SCHEDULES = 10;
ScheduleEntry schedules[MAX_SCHEDULES];

// Temperature sensor state
OneWire oneWire(ONE_WIRE_BUS);
DallasTemperature sensors(&oneWire);

struct SensorData {
  uint8_t address[8];
  char addressStr[17];  // Hex string representation
  char name[32];
  float tempC;
  bool valid;
};

SensorData sensorCache[MAX_SENSORS];
int sensorCount = 0;
unsigned long lastTempRead = 0;
const unsigned long TEMP_READ_INTERVAL = 2000;  // Read every 2 seconds

// ============== SHA-256 HELPER ==============
String sha256(const String& input) {
  unsigned char hash[32];
  mbedtls_sha256_context ctx;
  
  mbedtls_sha256_init(&ctx);
  mbedtls_sha256_starts(&ctx, 0);  // 0 = SHA-256 (not SHA-224)
  mbedtls_sha256_update(&ctx, (const unsigned char*)input.c_str(), input.length());
  mbedtls_sha256_finish(&ctx, hash);
  mbedtls_sha256_free(&ctx);
  
  // Convert to hex string
  String result = "";
  for (int i = 0; i < 32; i++) {
    char hex[3];
    sprintf(hex, "%02x", hash[i]);
    result += hex;
  }
  return result;
}

bool verifyAuth(const String& providedHash) {
  // Compare provided hash with stored hash (case-insensitive)
  String storedHash = String(AUTH_CODE_HASH);
  storedHash.toLowerCase();
  String compareHash = providedHash;
  compareHash.toLowerCase();
  return storedHash.equals(compareHash);
}

// ============== PIN CONFIGURATION ==============
void loadPinConfiguration() {
  preferences.begin("fan_config", true);  // Read-only
  
  // Load fan count and pins
  fanCount = preferences.getInt("fan_count", 1);
  fanCount = constrain(fanCount, 1, MAX_FANS);
  
  for (int i = 0; i < fanCount; i++) {
    String key = "fan" + String(i) + "_pin";
    FAN_PINS[i] = preferences.getInt(key.c_str(), (i == 0) ? 15 : 0);
  }
  
  // Load temperature sensor pin
  ONE_WIRE_BUS = preferences.getInt("onewire_pin", 22);
  
  preferences.end();
  
  Serial.printf("[CONFIG] Fan Count: %d\n", fanCount);
  for (int i = 0; i < fanCount; i++) {
    Serial.printf("[CONFIG] Fan %d PWM Pin: GPIO %d\n", i, FAN_PINS[i]);
  }
  Serial.printf("[CONFIG] OneWire Pin: GPIO %d\n", ONE_WIRE_BUS);
}

void savePinConfiguration(int* pins, int count) {
  preferences.begin("fan_config", false);  // Read-write
  
  count = constrain(count, 1, MAX_FANS);
  preferences.putInt("fan_count", count);
  
  for (int i = 0; i < count; i++) {
    String key = "fan" + String(i) + "_pin";
    preferences.putInt(key.c_str(), pins[i]);
  }
  
  preferences.end();
  Serial.printf("[CONFIG] Saved %d fan pins (restart required)\n", count);
}

void saveTempPinConfiguration(int pin) {
  preferences.begin("fan_config", false);  // Read-write
  preferences.putInt("onewire_pin", pin);
  preferences.end();
  Serial.printf("[CONFIG] Saved OneWire Pin: GPIO %d (restart required)\n", pin);
}

// ============== PWM CONTROL ==============
void setFanSpeed(int speedPercent) {
  speedPercent = constrain(speedPercent, 0, 100);
  currentSpeed = speedPercent;
  
  if (!fanEnabled) {
    // Turn off all fans
    for (int i = 0; i < fanCount; i++) {
      ledcWrite(FAN_PINS[i], 0);
    }
    Serial.println("[FAN] Disabled - all fans set to 0");
    return;
  }
  
  // Convert percentage to PWM value (0-255 for 8-bit resolution)
  int pwmValue = map(speedPercent, 0, 100, 0, 255);
  
  // Apply same speed to all fans
  for (int i = 0; i < fanCount; i++) {
    ledcWrite(FAN_PINS[i], pwmValue);
  }
  
  Serial.printf("[FAN] %d fan(s) set to %d%% (PWM: %d)\n", fanCount, speedPercent, pwmValue);
  
  // Save to NVS
  preferences.begin("fan_state", false);
  preferences.putInt("speed", speedPercent);
  preferences.end();
}

// ============== SCHEDULE FUNCTIONS ==============
void loadSchedules() {
  preferences.begin("fan_sched", true);  // Read-only
  for (int i = 0; i < MAX_SCHEDULES; i++) {
    String key = "s" + String(i);
    uint32_t packed = preferences.getUInt(key.c_str(), 0);
    
    schedules[i].enabled = (packed >> 24) & 0x01;
    schedules[i].hour = (packed >> 16) & 0x1F;
    schedules[i].minute = (packed >> 8) & 0x3F;
    schedules[i].speed = packed & 0x7F;
  }
  preferences.end();
  Serial.println("[SCHEDULE] Loaded from NVS");
}

void saveSchedules() {
  preferences.begin("fan_sched", false);  // Read-write
  for (int i = 0; i < MAX_SCHEDULES; i++) {
    String key = "s" + String(i);
    uint32_t packed = 0;
    packed |= ((uint32_t)(schedules[i].enabled & 0x01)) << 24;
    packed |= ((uint32_t)(schedules[i].hour & 0x1F)) << 16;
    packed |= ((uint32_t)(schedules[i].minute & 0x3F)) << 8;
    packed |= (uint32_t)(schedules[i].speed & 0x7F);
    preferences.putUInt(key.c_str(), packed);
  }
  preferences.end();
  Serial.println("[SCHEDULE] Saved to NVS");
}

void checkSchedules() {
  struct tm timeinfo;
  if (!getLocalTime(&timeinfo)) {
    return;  // Time not synced yet
  }
  
  int currentHour = timeinfo.tm_hour;
  int currentMinute = timeinfo.tm_min;
  
  for (int i = 0; i < MAX_SCHEDULES; i++) {
    if (schedules[i].enabled && 
        schedules[i].hour == currentHour && 
        schedules[i].minute == currentMinute) {
      Serial.printf("[SCHEDULE] Triggered: %02d:%02d -> %d%%\n", 
                    currentHour, currentMinute, schedules[i].speed);
      setFanSpeed(schedules[i].speed);
    }
  }
}

// ============== TEMPERATURE SENSOR HELPERS ==============

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
      sensorCache[i].name[sizeof(sensorCache[i].name) - 1] = '\0'; // Ensure null termination
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
  server.sendHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

void handleOptions() {
  handleCORS();
  server.send(204);
}

void handleStatus() {
  handleCORS();
  
  StaticJsonDocument<2048> doc;
  
  // Fan data
  doc["available"] = true;
  doc["device"] = "ESP32 Smart Tent Controller";
  doc["speed"] = currentSpeed;
  doc["enabled"] = fanEnabled;
  doc["ip"] = WiFi.localIP().toString();
  doc["rssi"] = WiFi.RSSI();
  
  // Get current time
  struct tm timeinfo;
  if (getLocalTime(&timeinfo)) {
    char timeStr[32];
    strftime(timeStr, sizeof(timeStr), "%Y-%m-%d %H:%M:%S", &timeinfo);
    doc["time"] = timeStr;
  }
  
  // Temperature data
  doc["sensor_count"] = sensorCount;
  JsonArray sensorsArray = doc.createNestedArray("sensors");
  for (int i = 0; i < sensorCount; i++) {
    JsonObject sensor = sensorsArray.createNestedObject();
    sensor["address"] = sensorCache[i].addressStr;
    sensor["name"] = sensorCache[i].name;
    if (sensorCache[i].valid) {
      sensor["temp_c"] = sensorCache[i].tempC;
    }
    sensor["valid"] = sensorCache[i].valid;
  }
  
  // Add schedule summary
  JsonArray schedArray = doc.createNestedArray("schedules");
  for (int i = 0; i < MAX_SCHEDULES; i++) {
    if (schedules[i].enabled) {
      JsonObject sched = schedArray.createNestedObject();
      sched["id"] = i;
      char timeStr[6];
      sprintf(timeStr, "%02d:%02d", schedules[i].hour, schedules[i].minute);
      sched["time"] = timeStr;
      sched["speed"] = schedules[i].speed;
    }
  }
  
  String response;
  serializeJson(doc, response);
  server.send(200, "application/json", response);
}

void handleSetSpeed() {
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
  
  // Verify authentication
  if (!doc.containsKey("auth_hash")) {
    server.send(401, "application/json", "{\"error\":\"Missing auth_hash\"}");
    return;
  }
  
  String providedHash = doc["auth_hash"].as<String>();
  if (!verifyAuth(providedHash)) {
    Serial.println("[AUTH] Failed authentication attempt");
    server.send(403, "application/json", "{\"error\":\"Invalid code\"}");
    return;
  }
  
  // Set speed
  if (!doc.containsKey("speed")) {
    server.send(400, "application/json", "{\"error\":\"Missing speed\"}");
    return;
  }
  
  int newSpeed = doc["speed"].as<int>();
  setFanSpeed(newSpeed);
  
  server.send(200, "application/json", "{\"success\":true,\"speed\":" + String(currentSpeed) + "}");
}

void handleSetPin() {
  handleCORS();
  
  if (!server.hasArg("plain")) {
    server.send(400, "application/json", "{\"error\":\"No body\"}");
    return;
  }
  
  StaticJsonDocument<512> doc;
  DeserializationError error = deserializeJson(doc, server.arg("plain"));
  
  if (error) {
    server.send(400, "application/json", "{\"error\":\"Invalid JSON\"}");
    return;
  }
  
  if (!doc.containsKey("auth_hash")) {
    server.send(401, "application/json", "{\"error\":\"Missing auth_hash\"}");
    return;
  }
  
  String authHash = doc["auth_hash"].as<String>();
  if (!verifyAuth(authHash)) {
    server.send(403, "application/json", "{\"error\":\"Invalid code\"}");
    return;
  }
  
  if (!doc.containsKey("pins")) {
    server.send(400, "application/json", "{\"error\":\"Missing pins array\"}");
    return;
  }
  
  JsonArray pinsArray = doc["pins"];
  int count = pinsArray.size();
  
  if (count < 1 || count > MAX_FANS) {
    server.send(400, "application/json", "{\"error\":\"Invalid pin count (1-4)\"}");
    return;
  }
  
  int pins[MAX_FANS];
  for (int i = 0; i < count; i++) {
    pins[i] = pinsArray[i];
    if (pins[i] < 0 || pins[i] > 39) {
      server.send(400, "application/json", "{\"error\":\"Invalid pin (must be 0-39)\"}");
      return;
    }
  }
  
  savePinConfiguration(pins, count);
  
  server.send(200, "application/json", "{\"success\":true,\"message\":\"Pins saved. Restart ESP32 to apply.\"}");
}

void handleGetSchedule() {
  handleCORS();
  
  StaticJsonDocument<1024> doc;
  JsonArray schedArray = doc.createNestedArray("schedules");
  
  for (int i = 0; i < MAX_SCHEDULES; i++) {
    JsonObject sched = schedArray.createNestedObject();
    sched["id"] = i;
    sched["enabled"] = schedules[i].enabled;
    sched["hour"] = schedules[i].hour;
    sched["minute"] = schedules[i].minute;
    sched["speed"] = schedules[i].speed;
  }
  
  String response;
  serializeJson(doc, response);
  server.send(200, "application/json", response);
}

void handleSetSchedule() {
  handleCORS();
  
  if (!server.hasArg("plain")) {
    server.send(400, "application/json", "{\"error\":\"No body\"}");
    return;
  }
  
  StaticJsonDocument<1024> doc;
  DeserializationError error = deserializeJson(doc, server.arg("plain"));
  
  if (error) {
    server.send(400, "application/json", "{\"error\":\"Invalid JSON\"}");
    return;
  }
  
  // Verify authentication
  if (!doc.containsKey("auth_hash")) {
    server.send(401, "application/json", "{\"error\":\"Missing auth_hash\"}");
    return;
  }
  
  String providedHash = doc["auth_hash"].as<String>();
  if (!verifyAuth(providedHash)) {
    Serial.println("[AUTH] Failed authentication attempt");
    server.send(403, "application/json", "{\"error\":\"Invalid code\"}");
    return;
  }
  
  // Update schedules
  if (!doc.containsKey("schedules")) {
    server.send(400, "application/json", "{\"error\":\"Missing schedules\"}");
    return;
  }
  
  JsonArray schedArray = doc["schedules"];
  for (int i = 0; i < min((int)schedArray.size(), MAX_SCHEDULES); i++) {
    JsonObject sched = schedArray[i];
    int id = sched["id"] | i;
    if (id >= 0 && id < MAX_SCHEDULES) {
      schedules[id].enabled = sched["enabled"] | false;
      schedules[id].hour = sched["hour"] | 0;
      schedules[id].minute = sched["minute"] | 0;
      schedules[id].speed = sched["speed"] | 0;
    }
  }
  
  saveSchedules();
  server.send(200, "application/json", "{\"success\":true}");
}

void handleAuth() {
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
  
  if (!doc.containsKey("auth_hash")) {
    server.send(401, "application/json", "{\"error\":\"Missing auth_hash\"}");
    return;
  }
  
  String providedHash = doc["auth_hash"].as<String>();
  if (verifyAuth(providedHash)) {
    server.send(200, "application/json", "{\"success\":true}");
  } else {
    server.send(403, "application/json", "{\"error\":\"Invalid code\"}");
  }
}

void handleTempDetect() {
  handleCORS();
  
  Serial.println("[API] Detecting temperature sensors...");
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

void handleSetTempName() {
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
      sensorCache[i].name[sizeof(sensorCache[i].name) - 1] = '\0';
      break;
    }
  }
  
  server.send(200, "application/json", "{\"success\":true}");
}

void handleSetTempPin() {
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
  
  if (!doc.containsKey("auth_hash")) {
    server.send(401, "application/json", "{\"error\":\"Missing auth_hash\"}");
    return;
  }
  
  String authHash = doc["auth_hash"].as<String>();
  if (!verifyAuth(authHash)) {
    server.send(403, "application/json", "{\"error\":\"Invalid code\"}");
    return;
  }
  
  if (!doc.containsKey("pin")) {
    server.send(400, "application/json", "{\"error\":\"Missing pin\"}");
    return;
  }
  
  int pin = doc["pin"];
  if (pin < 0 || pin > 39) {
    server.send(400, "application/json", "{\"error\":\"Invalid pin (must be 0-39)\"}");
    return;
  }
  
  saveTempPinConfiguration(pin);
  
  server.send(200, "application/json", "{\"success\":true,\"message\":\"Temperature pin saved. Restart ESP32 to apply.\"}");
}

// ============== SETUP & LOOP ==============
void setup() {
  Serial.begin(115200);
  Serial.println("\n=================================");
  Serial.println("ESP32 Smart Tent Controller");
  Serial.println("=================================");
  
  // Load pin configuration from NVS
  loadPinConfiguration();
  
  // Initialize PWM for all fans (Arduino Core 3.x API)
  for (int i = 0; i < fanCount; i++) {
    ledcAttach(FAN_PINS[i], PWM_FREQ, PWM_RESOLUTION);
    Serial.printf("[FAN] PWM initialized on GPIO %d (Fan %d)\n", FAN_PINS[i], i);
  }
  
  // Initialize temperature sensors
  Serial.printf("[TEMP] OneWire initialized on GPIO %d\n", ONE_WIRE_BUS);
  detectSensors();
  Serial.printf("[TEMP] Detected %d sensors\n", sensorCount);
  
  // Load schedules from NVS
  loadSchedules();
  
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
  
  // Sync time via NTP
  configTime(GMT_OFFSET_SEC, DAYLIGHT_OFFSET_SEC, NTP_SERVER);
  
  // Setup HTTP routes
  server.on("/status", HTTP_GET, handleStatus);
  server.on("/status", HTTP_OPTIONS, handleOptions);
  
  server.on("/speed", HTTP_POST, handleSetSpeed);
  server.on("/speed", HTTP_OPTIONS, handleOptions);
  
  server.on("/pin", HTTP_POST, handleSetPin);
  server.on("/pin", HTTP_OPTIONS, handleOptions);
  
  server.on("/schedules", HTTP_GET, handleGetSchedule);
  server.on("/schedules", HTTP_POST, handleSetSchedule);
  server.on("/schedules", HTTP_OPTIONS, handleOptions);
  
  server.on("/auth", HTTP_POST, handleAuth);
  server.on("/auth", HTTP_OPTIONS, handleOptions);
  
  // Temperature endpoints
  server.on("/detect", HTTP_GET, handleTempDetect);
  server.on("/detect", HTTP_OPTIONS, handleOptions);
  
  server.on("/name", HTTP_POST, handleSetTempName);
  server.on("/name", HTTP_OPTIONS, handleOptions);
  
  server.on("/temp_pin", HTTP_POST, handleSetTempPin);
  server.on("/temp_pin", HTTP_OPTIONS, handleOptions);
  
  server.begin();
  Serial.printf("[HTTP] Server started on port %d\n", SERVER_PORT);
  Serial.println("=================================\n");
}

unsigned long lastScheduleCheck = 0;
const unsigned long SCHEDULE_CHECK_INTERVAL = 60000;  // Check every minute

void loop() {
  server.handleClient();
  
  // Read temperature sensors periodically
  if (millis() - lastTempRead >= TEMP_READ_INTERVAL) {
    lastTempRead = millis();
    readSensors();
  }
  
  // Check schedules every minute
  if (millis() - lastScheduleCheck >= SCHEDULE_CHECK_INTERVAL) {
    lastScheduleCheck = millis();
    checkSchedules();
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
