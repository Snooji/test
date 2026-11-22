// A shared, always-running game of four AI movers that plays behind the main menu.
// Visitors watch without signing in; they are never movers and nothing here counts toward stats.
import { MoveRoom } from './MoveRoom.js';

export class DemoRoom extends MoveRoom {
  maxClients = 500;

  onAuth() { return true; }

  onCreate() {
    this.demo = true;
    super.onCreate({ difficulty: 'hard' });
    for (let i = 0; i < 4; i++) this.addBot();
    this.startRound();
  }

  onJoin() { /* spectators only */ }
  async onLeave() { /* nothing to clean up */ }

  tick(dt) {
    super.tick(dt);
    // results → short pause → a fresh house, forever
    if (this.phase === 'results') {
      this.demoRest = (this.demoRest || 0) + dt;
      if (this.demoRest > 6) { this.demoRest = 0; this.newLevel(); this.startRound(); }
    }
  }
}
