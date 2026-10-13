from machine import Pin
from time import sleep_ms

led = Pin(15, Pin.OUT)
button = Pin(0, Pin.IN, Pin.PULL_UP)   # wired to GND: reads 0 while the button is pressed

while True:
    led.value(0 if button.value() else 1)
    sleep_ms(10)
