#include <OneWire.h>
#include <DallasTemperature.h>

// Multiplexer Control Pins
#define MUX_S0 5
#define MUX_S1 18
#define MUX_S2 21
#define MUX_S3 19

// Analog Input Pin from MUX SIG
#define MUX_SIG 33

// EC Measurement Pins (Power / Ground for Voltage Divider)
#define PIN_PROBE 25
#define PIN_RESISTOR_SOURCE 26

// OneWire Bus for DS18B20 Temp Sensors
#define ONE_WIRE_BUS 32

OneWire oneWire(ONE_WIRE_BUS);
DallasTemperature tempSensors(&oneWire);

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("\n\nStarting ESP32 MUX & Temp Sensor Test...");

  // Setup MUX pins
  pinMode(MUX_S0, OUTPUT);
  pinMode(MUX_S1, OUTPUT);
  pinMode(MUX_S2, OUTPUT);
  pinMode(MUX_S3, OUTPUT);
  
  // Setup ADC
  pinMode(MUX_SIG, INPUT);
  analogReadResolution(12); // ESP32 is 12-bit by default (0-4095)

  // Setup EC pulse pins
  pinMode(PIN_PROBE, OUTPUT);
  pinMode(PIN_RESISTOR_SOURCE, OUTPUT);
  digitalWrite(PIN_PROBE, LOW);
  digitalWrite(PIN_RESISTOR_SOURCE, LOW);

  // Try to enable the ESP32's internal pull-up resistor (sometimes helps if an external 4.7k resistor is missing)
  pinMode(ONE_WIRE_BUS, INPUT_PULLUP);

  // Start Temp Sensors
  tempSensors.begin();
  int deviceCount = tempSensors.getDeviceCount();
  Serial.printf("Found %d temperature sensors on OneWire bus.\n", deviceCount);
}

void setMuxChannel(int channel) {
  // Select the channel on the 16CH multiplexer (CD74HC4067 or similar)
  digitalWrite(MUX_S0, (channel & 1) ? HIGH : LOW);
  digitalWrite(MUX_S1, (channel & 2) ? HIGH : LOW);
  digitalWrite(MUX_S2, (channel & 4) ? HIGH : LOW);
  digitalWrite(MUX_S3, (channel & 8) ? HIGH : LOW);
}

void loop() {
  Serial.println("\n--- New Reading Cycle ---");

  // 1. Read Temperatures
  tempSensors.requestTemperatures();
  int deviceCount = tempSensors.getDeviceCount();
  if (deviceCount == 0) {
    Serial.println("No temperature sensors found! Check wiring on pin 32.");
  } else {
    for (int i = 0; i < deviceCount; i++) {
        float tempC = tempSensors.getTempCByIndex(i);
        Serial.printf("Temp Sensor %d: %.2f °C\n", i, tempC);
    }
  }

  // 2. Read EC on all MUX channels
  Serial.println("Scanning 16 MUX Channels...");
  for (int ch = 0; ch < 16; ch++) {
    setMuxChannel(ch);
    delay(10); // Allow MUX to settle

    // To measure EC we need to pulse the voltage divider
    // Pulse Power ON
    digitalWrite(PIN_PROBE, HIGH);
    digitalWrite(PIN_RESISTOR_SOURCE, LOW);
    delay(20); // Time to stabilize in water
    
    // Read the voltage at the junction
    int rawMuxVal = analogRead(MUX_SIG);
    
    // Pulse Reverse (Keep bolts clean / prevent electrolysis)
    digitalWrite(PIN_PROBE, LOW);
    digitalWrite(PIN_RESISTOR_SOURCE, HIGH);
    delay(10);
    
    // Turn power off
    digitalWrite(PIN_RESISTOR_SOURCE, LOW);
    digitalWrite(PIN_PROBE, LOW);

    // Output reading
    Serial.printf("MUX Channel %02d | Raw ADC: %d\n", ch, rawMuxVal);
  }

  // Wait 5 seconds before the next loop
  delay(5000); 
}
