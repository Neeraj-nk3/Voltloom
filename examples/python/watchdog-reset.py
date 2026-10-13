from machine import Pin, WDT, reset_cause, WDT_RESET
from time import sleep_ms

led = Pin(15, Pin.OUT)

if reset_cause() == WDT_RESET:
    print("restarted by the watchdog")
    led.off()
    while True:
        sleep_ms(100)

print("power-on start")
led.on()
wdt = WDT(timeout=1000)
for i in range(3):
    sleep_ms(300)
    wdt.feed()
    print("fed", i)

print("no more feeding")
while True:
    sleep_ms(100)
