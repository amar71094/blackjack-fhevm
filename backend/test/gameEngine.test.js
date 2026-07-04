const { expect } = require('chai');
const { TableSession, handTotal, deckCommitment, buildDeckOrder } = require('../oracle/gameEngine');

describe('TableSession recovery', function () {
  it('rebuilds hands from the action log when in-memory hands were lost', function () {
    const session = new TableSession(1);
    const seed = 42n;
    const active = ['0xAlice0000000000000000000000000000000001', '0xBob00000000000000000000000000000000002'];

    session.resetForDeal(seed);
    session.recordDeal(active);

    const aliceHit = session.previewHit(active[0]);
    session.commitHit(active[0], aliceHit.card, aliceHit.nextCursor);

    const bobHit = session.previewHit(active[1]);
    session.commitHit(active[1], bobHit.card, bobHit.nextCursor);

    const dealerPreview = session.previewDealerDraw();
    session.commitDealerDraw(dealerPreview.newCards, dealerPreview.nextCursor);

    const play = {
      dealer: { cardCount: session.dealerHand.length },
      players: active.map((addr) => ({
        addr,
        bet: 100n,
        cardCount: session.getPlayerRanks(addr).length
      }))
    };

    expect(session.matchesPlay(play)).to.equal(true);

    session.dealerHand = [];
    session.playerHands.clear();
    expect(session.matchesPlay(play)).to.equal(false);

    const rebuilt = session.tryRebuildFromActionLog(active, play);
    expect(rebuilt).to.equal(true);
    expect(session.matchesPlay(play)).to.equal(true);
    expect(handTotal(session.getDealerRanks())).to.be.greaterThan(0);
  });

  it('recovers from a persisted deal seed when hands were cleared', function () {
    const session = new TableSession(3);
    const seed = 77n;
    const active = ['0xAlice0000000000000000000000000000000001'];

    session.resetForDeal(seed);
    session.recordDeal(active);
    session.dealSeed = seed.toString();
    session.deckCommitment = '0xabc';

    const play = {
      dealer: { cardCount: session.dealerHand.length },
      players: [{ addr: active[0], bet: 25n, cardCount: 2 }]
    };

    session.dealerHand = [];
    session.playerHands.clear();
    expect(session.tryRecoverFromDealSeed(active, play)).to.equal(true);
  });

  it('syncs player card counts from on-chain play state', function () {
    const session = new TableSession(4);
    session.resetForDeal(101n);
    const active = ['0xAlice0000000000000000000000000000000001', '0xBob00000000000000000000000000000000002'];
    session.recordDeal(active);

    const play = {
      dealer: { cardCount: 2 },
      players: [
        { addr: active[0], bet: 50n, cardCount: 3 },
        { addr: active[1], bet: 50n, cardCount: 4 }
      ]
    };

    expect(session.matchesPlay(play)).to.equal(false);
    session.syncFromChainPlay(play);
    expect(session.matchesPlay(play)).to.equal(true);
  });

  it('tracks deck commitment for the active deal seed', function () {
    const seed = 555n;
    const deckOrder = buildDeckOrder(seed);
    const commitment = deckCommitment(deckOrder);
    const session = new TableSession(5);
    session.resetForDeal(seed);
    expect(deckCommitment(session.deckOrder)).to.equal(commitment);
  });

  it('refuses settle payloads with zero totals when cards exist', function () {
    const session = new TableSession(2);
    session.resetForDeal(99n);
    session.recordDeal(['0xAlice0000000000000000000000000000000001']);

    const payload = session.buildSettlePayload([
      { addr: '0xAlice0000000000000000000000000000000001', bet: 50n }
    ]);

    expect(payload.dealerTotal).to.be.greaterThan(0);
    expect(payload.totals[0]).to.be.greaterThan(0);
  });
});