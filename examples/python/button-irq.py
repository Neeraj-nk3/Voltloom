from machine import Pin
from time import sleep_ms

led = Pin(15, Pin.OUT)
button = Pin(0, Pin.IN, Pin.PULL_UP)
presses = 0


def on_press(pin):
    global presses
    presses += 1
    led.toggle()
    print("press", presses)


button.irq(trigger=Pin.IRQ_FALLING, handler=on_press)

while True:
    sleep_ms(100)
