from machine import Pin, PWM
from time import sleep_ms

pwm = PWM(Pin(15), freq=1000)

for step in range(0, 9):
    duty = min(step * 8192, 65535)          # duty_u16 runs from 0 to 65535
    pwm.duty_u16(duty)
    print("duty", duty)
    sleep_ms(250)

print("done")
