/**
 * ESP32 PWM Fan Controller for Smart Tent Dashboard
 * 
 * Features:
 * - HTTP API for remote control
 * - PWM speed control (0-100%)
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

// ============== CONFIGURATION ==============
// WiFi credentials - CHANGE THESE
const char* WIFI_SSID = "DirtHut";
const char* WIFI_PASSWORD = "IchurakuStand3";

// PWM Fan Configuration
const int FAN_PWM_PIN = 15;           // GPIO pin for PWM output (change as needed)
const int PWM_FREQ = 25000;           // 25kHz - standard for 4-pin PWM fans
const int PWM_RESOLUTION = 8;         // 8-bit resolution (0-255)

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

// Current state
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

// ============== PWM CONTROL ==============
void setFanSpeed(int speedPercent) {
  speedPercent = constrain(speedPercent, 0, 100);
  currentSpeed = speedPercent;
  
  // Convert percentage to PWM duty cycle
  int duty = map(speedPercent, 0, 100, 0, 255);
  ledcWrite(FAN_PWM_PIN, duty);  // ESP32 Core 3.x uses pin directly
  
  // Save to preferences
  preferences.putInt("speed", currentSpeed);
  
  Serial.printf("[FAN] Speed set to %d%% (duty: %d)\n", speedPercent, duty);
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
  
  StaticJsonDocument<512> doc;
  doc["available"] = true;
  doc["device"] = "ESP32 PWM Fan";
  doc["speed"] = currentSpeed;
  doc["enabled"] = fanEnabled;
  doc["ip"] = WiFi.localIP().toString();
  doc["rssi"] = WiFi.RSSI();
  
  // Get current time
  struct tm timeinfo;
  if (getLocalTime(&timeinfo)) {
    char timeStr[20];
    strftime(timeStr, sizeof(timeStr), "%H:%M:%S", &timeinfo);
    doc["time"] = timeStr;
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

// ============== SETUP & LOOP ==============
void setup() {
  Serial.begin(115200);
  Serial.println("\n=================================");
  Serial.println("ESP32 PWM Fan Controller");
  Serial.println("=================================");
  
  // Initialize PWM (ESP32 Arduino Core 3.x API)
  ledcAttach(FAN_PWM_PIN, PWM_FREQ, PWM_RESOLUTION);
  Serial.printf("[PWM] Initialized on GPIO %d\n", FAN_PWM_PIN);
  
  // Load saved speed
  preferences.begin("fan_state", true);
  currentSpeed = preferences.getInt("speed", 0);
  preferences.end();
  setFanSpeed(currentSpeed);
  
  // Load schedules
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
    
    // Sync time via NTP
    configTime(GMT_OFFSET_SEC, DAYLIGHT_OFFSET_SEC, NTP_SERVER);
    Serial.println("[NTP] Time sync initiated");
  } else {
    Serial.println(" FAILED!");
    Serial.println("[WIFI] Running in offline mode");
  }
  
  // Setup HTTP routes
  server.on("/status", HTTP_GET, handleStatus);
  server.on("/status", HTTP_OPTIONS, handleOptions);
  
  server.on("/speed", HTTP_POST, handleSetSpeed);
  server.on("/speed", HTTP_OPTIONS, handleOptions);
  
  server.on("/schedule", HTTP_GET, handleGetSchedule);
  server.on("/schedule", HTTP_POST, handleSetSchedule);
  server.on("/schedule", HTTP_OPTIONS, handleOptions);
  
  server.on("/auth", HTTP_POST, handleAuth);
  server.on("/auth", HTTP_OPTIONS, handleOptions);
  
  server.begin();
  Serial.printf("[HTTP] Server started on port %d\n", SERVER_PORT);
  Serial.println("=================================\n");
}

unsigned long lastScheduleCheck = 0;
const unsigned long SCHEDULE_CHECK_INTERVAL = 60000;  // Check every minute

void loop() {
  server.handleClient();
  
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
