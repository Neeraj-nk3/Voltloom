from machine import Pin
import time

red = Pin(22, Pin.OUT)      # GP22 -> 220 ohm -> red LED -> GND
yellow = Pin(19, Pin.OUT)   # GP19 -> 220 ohm -> yellow LED -> GND
green = Pin(16, Pin.OUT)    # GP16 -> 220 ohm -> green LED -> GND

def show(r, y, g, seconds, name):
    red.value(r)
    yellow.value(y)
    green.value(g)
    print("Light:", name)
    time.sleep(seconds)

while True:
    show(1, 0, 0, 2.0, "red")
    show(1, 1, 0, 1.0, "red + yellow")
    show(0, 0, 1, 2.0, "green")
    show(0, 1, 0, 1.0, "yellow")
