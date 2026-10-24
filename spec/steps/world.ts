// The DSL layer's World: the one object every step definition reaches the product through.
// Steps speak the project's words and call the Send arm modules under spec/support/send/;
// they never name a command line, a port or a protocol themselves.
import { type IWorldOptions, setWorldConstructor, World } from "@cucumber/cucumber";

import { type Answer, Binary } from "../support/send/binary.ts";

export class DriveWorld extends World {
  readonly binary: Binary;
  answer?: Answer;

  constructor(options: IWorldOptions) {
    super(options);
    this.binary = Binary.fromEnvironment();
  }

  lastAnswer(): Answer {
    if (!this.answer) throw new Error("no step has asked the binary anything yet");
    return this.answer;
  }
}

setWorldConstructor(DriveWorld);
