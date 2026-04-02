/**
 * ESP32 MUX EC Controller
 * 
 * 16-channel multiplexer EC monitoring with:
 * - Per-channel K-factor, naming, enable/disable, temp sensor assignment
 * - DS18B20 temperature sensors on OneWire bus
 * - Temperature-compensated EC readings
 * - Auto-calibration from reference meter readings
 * - HTTP API for Smart Tent Dashboard integration
 * 
 * Hardware:
 *   MUX Control: S0=5, S1=18, S2=21, S3=19
 *   MUX Signal:  SIG=33
 *   EC Divider:  Probe=25, Resistor=26
 *   Temp Bus:    OneWire=32
 */

#include <WiFi.h>
#include <WebServer.h>
#include <Preferences.h>
#include <ArduinoJson.h>
#include <mbedtls/sha256.h>
#include <OneWire.h>
#include <DallasTemperature.h>

// ============== CONFIGURATION ==============
const char* WIFI_SSID = "DirtHut";
const char* WIFI_PASSWORD = "IchurakuStand3";

// Multiplexer Control Pins (CD74HC4067)
#define MUX_S0 5
#define MUX_S1 18
#define MUX_S2 21
#define MUX_S3 19
#define MUX_SIG 33

// EC Measurement Pins (Voltage Divider)
#define PIN_PROBE 25
#define PIN_RESISTOR_SOURCE 26

// OneWire Bus for DS18B20
#define ONE_WIRE_BUS 32

// Hardware constants
const float RESISTOR_VALUE = 1000.0;
const int MAX_CHANNELS = 16;
const int MAX_TEMP_SENSORS = 8;
const int EC_SAMPLES = 25;       // Samples per reading for noise averaging
const int BURST_SAMPLES = 5;     // Burst samples for on-demand measurement

// Auth
const char* AUTH_CODE_HASH = "79f06f8fde333461739f220090a23cb2a79f6d714bee100d0e4b4af249294619";

// ============== GLOBALS ==============
WebServer server(80);
Preferences preferences;
OneWire oneWire(ONE_WIRE_BUS);
DallasTemperature tempSensors(&oneWire);

// --- Channel Configuration ---
struct ChannelConfig {
  bool enabled;
  char name[32];
  float kFactor;
  int tempSensorIndex;  // -1 = none, 0..N = temp sensor index
  // Runtime (not persisted)
  float lastEC;
  int lastRawADC;
  float lastTempC;
};

ChannelConfig channels[MAX_CHANNELS];

// --- Temperature Sensors ---
struct TempSensorInfo {
  uint8_t address[8];
  char addressStr[17];
  float tempC;
  bool valid;
};

TempSensorInfo tempSensorCache[MAX_TEMP_SENSORS];
int tempSensorCount = 0;
unsigned long lastTempRead = 0;
const unsigned long TEMP_READ_INTERVAL = 2000;

// ============== SHA-256 HELPER ==============
String sha256(const String& input) {
  unsigned char hash[32];
  mbedtls_sha256_context ctx;
  mbedtls_sha256_init(&ctx);
  mbedtls_sha256_starts(&ctx, 0);
  mbedtls_sha256_update(&ctx, (const unsigned char*)input.c_str(), input.length());
  mbedtls_sha256_finish(&ctx, hash);
  mbedtls_sha256_free(&ctx);
  
  String result = "";
  for (int i = 0; i < 32; i++) {
    char hex[3];
    sprintf(hex, "%02x", hash[i]);
    result += hex;
  }
  return result;
}

bool verifyAuth(const String& providedHash) {
  String storedHash = String(AUTH_CODE_HASH);
  storedHash.toLowerCase();
  String compareHash = providedHash;
  compareHash.toLowerCase();
  return storedHash.equals(compareHash);
}

// ============== MUX CONTROL ==============
void setMuxChannel(int channel) {
  digitalWrite(MUX_S0, (channel & 1) ? HIGH : LOW);
  digitalWrite(MUX_S1, (channel & 2) ? HIGH : LOW);
  digitalWrite(MUX_S2, (channel & 4) ? HIGH : LOW);
  digitalWrite(MUX_S3, (channel & 8) ? HIGH : LOW);
}

// ============== NVS PERSISTENCE ==============
void loadChannelConfig() {
  preferences.begin("ec_channels", true);  // Read-only
  
  for (int i = 0; i < MAX_CHANNELS; i++) {
    String prefix = "ch" + String(i) + "_";
    channels[i].enabled = preferences.getBool((prefix + "en").c_str(), false);
    
    String name = preferences.getString((prefix + "name").c_str(), "");
    if (name.length() > 0) {
      strncpy(channels[i].name, name.c_str(), sizeof(channels[i].name) - 1);
      channels[i].name[sizeof(channels[i].name) - 1] = '\0';
    } else {
      sprintf(channels[i].name, "Probe %d", i);
    }
    
    channels[i].kFactor = preferences.getFloat((prefix + "kf").c_str(), 1.9);
    channels[i].tempSensorIndex = preferences.getInt((prefix + "ts").c_str(), -1);
    
    // Initialize runtime values
    channels[i].lastEC = 0;
    channels[i].lastRawADC = 0;
    channels[i].lastTempC = -127.0;
  }
  
  preferences.end();
  Serial.println("[CONFIG] Channel config loaded from NVS");
}

void saveChannelConfig(int channel) {
  if (channel < 0 || channel >= MAX_CHANNELS) return;
  
  preferences.begin("ec_channels", false);  // Read-write
  
  String prefix = "ch" + String(channel) + "_";
  preferences.putBool((prefix + "en").c_str(), channels[channel].enabled);
  preferences.putString((prefix + "name").c_str(), channels[channel].name);
  preferences.putFloat((prefix + "kf").c_str(), channels[channel].kFactor);
  preferences.putInt((prefix + "ts").c_str(), channels[channel].tempSensorIndex);
  
  preferences.end();
  Serial.printf("[CONFIG] Saved config for channel %d\n", channel);
}

// ============== TEMPERATURE SENSORS ==============
void addressToString(uint8_t* addr, char* str) {
  sprintf(str, "%02X%02X%02X%02X%02X%02X%02X%02X",
    addr[0], addr[1], addr[2], addr[3],
    addr[4], addr[5], addr[6], addr[7]);
}

void detectTempSensors() {
  tempSensorCount = 0;
  tempSensors.begin();
  
  int deviceCount = tempSensors.getDeviceCount();
  Serial.printf("[TEMP] Found %d temperature sensors\n", deviceCount);
  
  for (int i = 0; i < deviceCount && i < MAX_TEMP_SENSORS; i++) {
    if (tempSensors.getAddress(tempSensorCache[i].address, i)) {
      addressToString(tempSensorCache[i].address, tempSensorCache[i].addressStr);
      tempSensorCache[i].tempC = -127.0;
      tempSensorCache[i].valid = false;
      tempSensorCount++;
    }
  }
}

void readTempSensors() {
  if (tempSensorCount == 0) return;
  
  tempSensors.requestTemperatures();
  
  for (int i = 0; i < tempSensorCount; i++) {
    float temp = tempSensors.getTempC(tempSensorCache[i].address);
    if (temp != DEVICE_DISCONNECTED_C && temp != -127.0) {
      tempSensorCache[i].tempC = temp;
      tempSensorCache[i].valid = true;
    } else {
      tempSensorCache[i].valid = false;
    }
  }
}

float getTempForChannel(int channel) {
  int idx = channels[channel].tempSensorIndex;
  if (idx < 0 || idx >= tempSensorCount) return -127.0;
  if (!tempSensorCache[idx].valid) return -127.0;
  return tempSensorCache[idx].tempC;
}

// ============== EC MEASUREMENT ==============
float readECSingle(int channel, int* outRaw) {
  setMuxChannel(channel);
  delay(10);  // Allow MUX to settle
  
  float totalConductivity = 0;
  long rawSum = 0;
  int validSamples = 0;
  
  for (int i = 0; i < EC_SAMPLES; i++) {
    // Pulse Power ON
    digitalWrite(PIN_PROBE, HIGH);
    digitalWrite(PIN_RESISTOR_SOURCE, LOW);
    delay(20);
    
    int val = analogRead(MUX_SIG);
    rawSum += val;
    
    // Pulse Reverse (keep probes clean)
    digitalWrite(PIN_PROBE, LOW);
    digitalWrite(PIN_RESISTOR_SOURCE, HIGH);
    delay(10);
    digitalWrite(PIN_RESISTOR_SOURCE, LOW);
    
    if (val > 20) {
      float voltage = (val / 4095.0) * 3.3;
      float resistanceWater = RESISTOR_VALUE * (voltage / (3.3 - voltage));
      totalConductivity += (1.0 / resistanceWater) * 1000000.0;
      validSamples++;
    }
  }
  
  *outRaw = rawSum / EC_SAMPLES;
  
  if (validSamples == 0) return 0.0;
  
  float rawEC = (totalConductivity / validSamples) * channels[channel].kFactor;
  
  // Temperature compensation: EC_comp = EC_raw / (1 + 0.02 * (T - 25))
  float tempC = getTempForChannel(channel);
  if (tempC > -100.0) {
    float compensation = 1.0 + 0.02 * (tempC - 25.0);
    rawEC = rawEC / compensation;
    channels[channel].lastTempC = tempC;
  } else {
    channels[channel].lastTempC = -127.0;
  }
  
  return rawEC;
}

void measureChannel(int channel) {
  float sumEC = 0;
  long sumRaw = 0;
  
  for (int i = 0; i < BURST_SAMPLES; i++) {
    int currentRaw = 0;
    float currentEC = readECSingle(channel, &currentRaw);
    sumEC += currentEC;
    sumRaw += currentRaw;
    delay(500);
  }
  
  channels[channel].lastEC = sumEC / BURST_SAMPLES;
  channels[channel].lastRawADC = sumRaw / BURST_SAMPLES;
}

void measureAllEnabled() {
  // Read temp sensors first
  readTempSensors();
  
  for (int ch = 0; ch < MAX_CHANNELS; ch++) {
    if (channels[ch].enabled) {
      measureChannel(ch);
      Serial.printf("[EC] CH%02d (%s): EC=%.0f, ADC=%d\n", 
        ch, channels[ch].name, channels[ch].lastEC, channels[ch].lastRawADC);
    }
  }
}

// ============== CORS HELPER ==============
void handleCORS() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  server.sendHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

void handleOptions() {
  handleCORS();
  server.send(204);
}

// ============== HTTP HANDLERS ==============

void handleStatus() {
  handleCORS();
  
  // Build a large JSON doc
  DynamicJsonDocument doc(8192);
  
  doc["available"] = true;
  doc["device"] = "ESP32 MUX EC Controller";
  doc["ip"] = WiFi.localIP().toString();
  doc["rssi"] = WiFi.RSSI();
  doc["max_channels"] = MAX_CHANNELS;
  
  // Channels array
  JsonArray channelsArr = doc.createNestedArray("channels");
  for (int i = 0; i < MAX_CHANNELS; i++) {
    JsonObject ch = channelsArr.createNestedObject();
    ch["id"] = i;
    ch["name"] = channels[i].name;
    ch["enabled"] = channels[i].enabled;
    ch["k_factor"] = channels[i].kFactor;
    ch["temp_sensor_index"] = channels[i].tempSensorIndex;
    ch["ec_us_cm"] = channels[i].lastEC;
    ch["raw_adc"] = channels[i].lastRawADC;
    ch["temp_c"] = channels[i].lastTempC;
    
    // Water status
    if (channels[i].enabled && channels[i].lastRawADC > 0) {
      ch["water_empty"] = (channels[i].lastRawADC < 150);
      if (channels[i].lastRawADC < 150) {
        ch["status"] = "WATER_LOW";
      } else if (channels[i].lastEC > 2400) {
        ch["status"] = "TOO_SALTY";
      } else if (channels[i].lastEC < 1600) {
        ch["status"] = "HUNGRY";
      } else {
        ch["status"] = "OPTIMAL";
      }
    }
  }
  
  // Temperature sensors
  doc["temp_sensor_count"] = tempSensorCount;
  JsonArray sensorsArr = doc.createNestedArray("temp_sensors");
  for (int i = 0; i < tempSensorCount; i++) {
    JsonObject s = sensorsArr.createNestedObject();
    s["index"] = i;
    s["address"] = tempSensorCache[i].addressStr;
    s["temp_c"] = tempSensorCache[i].tempC;
    s["valid"] = tempSensorCache[i].valid;
  }
  
  String response;
  serializeJson(doc, response);
  server.send(200, "application/json", response);
}

void handleMeasure() {
  handleCORS();
  
  int specificChannel = -1;
  if (server.hasArg("channel")) {
    specificChannel = server.arg("channel").toInt();
  }
  
  // Read temp sensors first
  readTempSensors();
  
  if (specificChannel >= 0 && specificChannel < MAX_CHANNELS) {
    measureChannel(specificChannel);
    Serial.printf("[MEASURE] Single channel %d: EC=%.0f\n", 
      specificChannel, channels[specificChannel].lastEC);
  } else {
    measureAllEnabled();
  }
  
  // Return full status
  handleStatus();
}

void handleChannelConfig() {
  handleCORS();
  
  if (!server.hasArg("plain")) {
    server.send(400, "application/json", "{\"error\":\"No body\"}");
    return;
  }
  
  DynamicJsonDocument doc(512);
  DeserializationError error = deserializeJson(doc, server.arg("plain"));
  
  if (error) {
    server.send(400, "application/json", "{\"error\":\"Invalid JSON\"}");
    return;
  }
  
  if (!doc.containsKey("channel")) {
    server.send(400, "application/json", "{\"error\":\"Missing channel\"}");
    return;
  }
  
  int ch = doc["channel"];
  if (ch < 0 || ch >= MAX_CHANNELS) {
    server.send(400, "application/json", "{\"error\":\"Invalid channel (0-15)\"}");
    return;
  }
  
  // Update fields if present
  if (doc.containsKey("enabled")) {
    channels[ch].enabled = doc["enabled"];
  }
  if (doc.containsKey("name")) {
    String name = doc["name"].as<String>();
    strncpy(channels[ch].name, name.c_str(), sizeof(channels[ch].name) - 1);
    channels[ch].name[sizeof(channels[ch].name) - 1] = '\0';
  }
  if (doc.containsKey("k_factor")) {
    channels[ch].kFactor = doc["k_factor"];
  }
  if (doc.containsKey("temp_sensor_index")) {
    channels[ch].tempSensorIndex = doc["temp_sensor_index"];
  }
  
  // Persist to NVS
  saveChannelConfig(ch);
  
  server.send(200, "application/json", "{\"success\":true}");
}

void handleCalibrate() {
  handleCORS();
  
  if (!server.hasArg("plain")) {
    server.send(400, "application/json", "{\"error\":\"No body\"}");
    return;
  }
  
  DynamicJsonDocument doc(256);
  DeserializationError error = deserializeJson(doc, server.arg("plain"));
  
  if (error) {
    server.send(400, "application/json", "{\"error\":\"Invalid JSON\"}");
    return;
  }
  
  if (!doc.containsKey("channel") || !doc.containsKey("reference_ec")) {
    server.send(400, "application/json", "{\"error\":\"Missing channel or reference_ec\"}");
    return;
  }
  
  int ch = doc["channel"];
  float referenceEC = doc["reference_ec"];
  
  if (ch < 0 || ch >= MAX_CHANNELS) {
    server.send(400, "application/json", "{\"error\":\"Invalid channel\"}");
    return;
  }
  
  if (referenceEC <= 0) {
    server.send(400, "application/json", "{\"error\":\"reference_ec must be > 0\"}");
    return;
  }
  
  // Take a fresh measurement with K=1.0 to get raw conductivity
  float oldK = channels[ch].kFactor;
  channels[ch].kFactor = 1.0;
  
  readTempSensors();
  measureChannel(ch);
  
  float rawEC = channels[ch].lastEC;
  
  if (rawEC <= 0) {
    channels[ch].kFactor = oldK;  // Restore
    server.send(400, "application/json", "{\"error\":\"Could not get a valid reading. Is the probe in water?\"}");
    return;
  }
  
  // K = reference / raw
  float newK = referenceEC / rawEC;
  channels[ch].kFactor = newK;
  
  // Re-measure with correct K
  measureChannel(ch);
  
  // Save
  saveChannelConfig(ch);
  
  Serial.printf("[CALIBRATE] CH%d: ref=%.0f, raw=%.0f, K=%.4f\n", ch, referenceEC, rawEC, newK);
  
  DynamicJsonDocument resp(256);
  resp["success"] = true;
  resp["channel"] = ch;
  resp["old_k_factor"] = oldK;
  resp["new_k_factor"] = newK;
  resp["calibrated_ec"] = channels[ch].lastEC;
  
  String response;
  serializeJson(resp, response);
  server.send(200, "application/json", response);
}

void handleSetKFactor() {
  // Legacy endpoint — sets K-factor for a channel
  handleCORS();
  
  if (!server.hasArg("plain")) {
    server.send(400, "application/json", "{\"error\":\"No body\"}");
    return;
  }
  
  DynamicJsonDocument doc(256);
  DeserializationError error = deserializeJson(doc, server.arg("plain"));
  
  if (error) {
    server.send(400, "application/json", "{\"error\":\"Invalid JSON\"}");
    return;
  }
  
  int ch = doc["channel"] | 0;  // Default to channel 0 for legacy compat
  
  if (doc.containsKey("kfactor")) {
    channels[ch].kFactor = doc["kfactor"];
    saveChannelConfig(ch);
    server.send(200, "application/json", "{\"success\":true}");
  } else {
    server.send(400, "application/json", "{\"error\":\"Missing kfactor\"}");
  }
}

void handleAuth() {
  handleCORS();
  
  if (!server.hasArg("plain")) {
    server.send(400, "application/json", "{\"error\":\"No body\"}");
    return;
  }
  
  DynamicJsonDocument doc(256);
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

void handleSensors() {
  handleCORS();
  
  DynamicJsonDocument doc(1024);
  doc["count"] = tempSensorCount;
  JsonArray arr = doc.createNestedArray("sensors");
  
  for (int i = 0; i < tempSensorCount; i++) {
    JsonObject s = arr.createNestedObject();
    s["index"] = i;
    s["address"] = tempSensorCache[i].addressStr;
    s["temp_c"] = tempSensorCache[i].tempC;
    s["valid"] = tempSensorCache[i].valid;
  }
  
  String response;
  serializeJson(doc, response);
  server.send(200, "application/json", response);
}

// ============== SETUP & LOOP ==============
void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("\n=================================");
  Serial.println("ESP32 MUX EC Controller");
  Serial.println("=================================");
  
  // Setup MUX pins
  pinMode(MUX_S0, OUTPUT);
  pinMode(MUX_S1, OUTPUT);
  pinMode(MUX_S2, OUTPUT);
  pinMode(MUX_S3, OUTPUT);
  pinMode(MUX_SIG, INPUT);
  analogReadResolution(12);
  
  // Setup EC pulse pins
  pinMode(PIN_PROBE, OUTPUT);
  pinMode(PIN_RESISTOR_SOURCE, OUTPUT);
  digitalWrite(PIN_PROBE, LOW);
  digitalWrite(PIN_RESISTOR_SOURCE, LOW);
  
  // Setup OneWire
  pinMode(ONE_WIRE_BUS, INPUT_PULLUP);
  
  // Load channel config
  loadChannelConfig();
  
  // Detect temperature sensors
  detectTempSensors();
  
  // Connect WiFi
  Serial.printf("[WIFI] Connecting to %s", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  
  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 30) {
    delay(500);
    Serial.print(".");
    attempts++;
  }
  
  if (WiFi.status() == WL_CONNECTED) {
    Serial.println(" Connected!");
    Serial.printf("[WIFI] IP: %s\n", WiFi.localIP().toString().c_str());
  } else {
    Serial.println(" FAILED!");
  }
  
  // HTTP routes
  server.on("/status", HTTP_GET, handleStatus);
  server.on("/status", HTTP_OPTIONS, handleOptions);
  
  server.on("/measure", HTTP_POST, handleMeasure);
  server.on("/measure", HTTP_OPTIONS, handleOptions);
  
  server.on("/channel/config", HTTP_POST, handleChannelConfig);
  server.on("/channel/config", HTTP_OPTIONS, handleOptions);
  
  server.on("/channel/calibrate", HTTP_POST, handleCalibrate);
  server.on("/channel/calibrate", HTTP_OPTIONS, handleOptions);
  
  server.on("/kfactor", HTTP_POST, handleSetKFactor);
  server.on("/kfactor", HTTP_OPTIONS, handleOptions);
  
  server.on("/auth", HTTP_POST, handleAuth);
  server.on("/auth", HTTP_OPTIONS, handleOptions);
  
  server.on("/sensors", HTTP_GET, handleSensors);
  server.on("/sensors", HTTP_OPTIONS, handleOptions);
  
  server.begin();
  Serial.println("[HTTP] Server started on port 80");
  Serial.println("=================================\n");
}

void loop() {
  server.handleClient();
  
  // Read temperature sensors periodically
  if (millis() - lastTempRead >= TEMP_READ_INTERVAL) {
    lastTempRead = millis();
    readTempSensors();
  }
  
  // WiFi reconnect
  if (WiFi.status() != WL_CONNECTED) {
    static unsigned long lastReconnect = 0;
    if (millis() - lastReconnect >= 30000) {
      lastReconnect = millis();
      Serial.println("[WIFI] Reconnecting...");
      WiFi.reconnect();
    }
  }
  
  delay(10);
}
