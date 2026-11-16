import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowRight, Check, Gift, LogIn, LogOut, Pencil, Plus, ShieldAlert, Sparkles, Star, Trash2, Trophy, X } from "lucide-react";
import {
  createReward,
  deleteReward,
  forfeitGame,
  getGame,
  getRedemptions,
  getRewards,
  getViewer,
  nextQuestion,
  redeemReward,
  startGame,
  submitAnswer,
  updateReward,
} from "./lib/api";
import type { AnswerResult, GameState, Redemption, Reward, RewardInput, Viewer } from "./types";

const emptyViewer: Viewer = { signedIn: false, email: null, isAdmin: false, isPlayer: false };
const emptyReward = (): RewardInput => ({ name: "", cost: 10, active: true });

export default function App() {
  const [viewer, setViewer] = useState(emptyViewer);
  const [game, setGame] = useState<GameState | null>(null);
  const [rewards, setRewards] = useState<Reward[]>([]);
  const [redemptions, setRedemptions] = useState<Redemption[]>([]);
  const [answer, setAnswer] = useState("");
  const [lastResult, setLastResult] = useState<AnswerResult | null>(null);
  const [rewardDraft, setRewardDraft] = useState<RewardInput>(emptyReward);
  const [editingRewardId, setEditingRewardId] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const forfeitReported = useRef(false);

  async function refresh() {
    const account = await getViewer();
    setViewer(account);
    if (account.isPlayer || account.isAdmin) setRewards(await getRewards());
    if (account.isPlayer) setGame(await getGame());
    if (account.isAdmin) setRedemptions(await getRedemptions());
  }

  useEffect(() => {
    void refresh().catch((cause: unknown) => setError(messageOf(cause, "Spelet kunde inte hämtas.")))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!viewer.isPlayer || !game?.isPlaying) return;
    const endGame = () => {
      if (forfeitReported.current) return;
      forfeitReported.current = true;
      void forfeitGame(true).then(({ game: updated, penalty }) => {
        setGame(updated);
        setLastResult(null);
        setAnswer("");
        setNotice(penalty
          ? `Du lämnade spelet. Spelet är slut och ${penalty} poäng drogs av.`
          : "Du lämnade spelet. Spelet är slut.");
      }).catch((cause: unknown) => {
        setError(messageOf(cause, "Spelet kunde inte avslutas."));
      });
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") endGame();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pagehide", endGame);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pagehide", endGame);
    };
  }, [viewer.isPlayer, game?.isPlaying]);

  async function run<T>(action: () => Promise<T>, onSuccess: (value: T) => void, fallback: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      onSuccess(await action());
    } catch (cause) {
      setError(messageOf(cause, fallback));
    } finally {
      setBusy(false);
    }
  }

  function signIn() {
    if (import.meta.env.DEV) {
      const email = window.prompt("Ange en e-postadress som finns i PLAYER_EMAILS eller GLOBAL_ADMIN_EMAILS:");
      if (email) {
        localStorage.setItem("mattespelet-dev-email", email.trim().toLowerCase());
        window.location.reload();
      }
      return;
    }
    window.location.assign("/.auth/login/aad");
  }

  function signOut() {
    if (import.meta.env.DEV) {
      localStorage.removeItem("mattespelet-dev-email");
      window.location.reload();
      return;
    }
    window.location.assign("/.auth/logout");
  }

  function beginGame() {
    void run(startGame, (updated) => {
      forfeitReported.current = false;
      setGame(updated);
      setLastResult(null);
      setAnswer("");
    }, "Spelet kunde inte starta.");
  }

  function requestNextQuestion() {
    void run(nextQuestion, setGame, "Nästa fråga kunde inte hämtas.");
    setLastResult(null);
    setAnswer("");
  }

  function sendAnswer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = Number(answer.trim());
    if (!answer.trim() || !Number.isInteger(value) || value < 0 || value > 144 || !game?.question) {
      setError("Skriv ett heltal mellan 0 och 144.");
      return;
    }
    void run(
      () => submitAnswer(game.question!.id, value),
      (result) => {
        setGame(result.game);
        setLastResult(result);
        setAnswer("");
      },
      "Svaret kunde inte skickas.",
    );
  }

  function saveReward(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = rewardDraft.name.trim();
    if (!name || !Number.isInteger(rewardDraft.cost) || rewardDraft.cost < 1 || rewardDraft.cost > 500) {
      setError("Ange ett namn och ett poängpris mellan 1 och 500.");
      return;
    }
    const input = { ...rewardDraft, name };
    void run(
      () => editingRewardId ? updateReward(editingRewardId, input) : createReward(input),
      (saved) => {
        setRewards((current) => [...current.filter((item) => item.id !== saved.id), saved]
          .sort((first, second) => first.cost - second.cost || first.name.localeCompare(second.name, "sv")));
        setRewardDraft(emptyReward());
        setEditingRewardId("");
        setNotice(`Belöningen ”${saved.name}” sparades.`);
      },
      "Belöningen kunde inte sparas.",
    );
  }

  function editReward(reward: Reward) {
    setEditingRewardId(reward.id);
    setRewardDraft({ name: reward.name, cost: reward.cost, active: reward.active });
  }

  function removeReward(reward: Reward) {
    if (!window.confirm(`Ta bort belöningen ”${reward.name}”?`)) return;
    void run(
      () => deleteReward(reward.id),
      () => {
        setRewards((current) => current.filter((item) => item.id !== reward.id));
        if (editingRewardId === reward.id) {
          setEditingRewardId("");
          setRewardDraft(emptyReward());
        }
      },
      "Belöningen kunde inte tas bort.",
    );
  }

  function buyReward(reward: Reward) {
    if (!window.confirm(`Lösa in ${reward.cost} poäng för ”${reward.name}”?`)) return;
    void run(
      () => redeemReward(reward.id),
      ({ points, redemption }) => {
        setGame((current) => current ? { ...current, points } : current);
        setRedemptions((current) => [redemption, ...current]);
        setNotice(`Du har löst in ”${reward.name}”. Prata med en vuxen om belöningen!`);
      },
      "Poängen kunde inte lösas in.",
    );
  }

  return <div className="app-shell">
    <header className="topbar">
      <a className="brand" href="#" aria-label="Mattespelet – startsida"><span className="brand-icon"><Sparkles size={21} /></span><span>Matte<strong>spelet</strong></span></a>
      <span className="topbar-note">LITEN HJÄRNA · STORA TAL</span>
      {viewer.signedIn
        ? <button className="account-button" onClick={signOut}><LogOut size={17} /> Logga ut</button>
        : <button className="account-button" onClick={signIn}><LogIn size={17} /> Logga in</button>}
    </header>

    <main>
      <section className="hero">
        <div className="hero-copy">
          <span className="eyebrow"><span className="status-dot" /> MULTIPLIKATION 1–12</span>
          <h1>Räkna dig<br /><em>till drömmen!</em></h1>
          <p>Träna gångertabellen, samla poäng och spara till något kul.</p>
        </div>
        <div className="hero-art" aria-hidden="true">
          <span className="math math-one">7 × 8</span><span className="math math-two">12 × 4</span>
          <div className="star-ball"><Star size={74} fill="currentColor" strokeWidth={1.5} /></div>
          <span className="hero-spark">✦</span>
        </div>
        <div className="hero-foot"><span>1 POÄNG · LÄTT</span><span>2 POÄNG · KLURIG</span><span>3 POÄNG · SUPERKLURIG</span></div>
      </section>

      {loading
        ? <div className="loading-card">Hämtar spelet…</div>
        : !viewer.signedIn
          ? <section className="login-card">
            <div className="login-icon"><Sparkles size={28} /></div>
            <h2>Dags för en matteutmaning?</h2>
            <p>Logga in med ditt Microsoft-konto för att spela och spara dina poäng.</p>
            <button className="button button-primary" onClick={signIn}><LogIn size={18} /> Logga in och spela</button>
          </section>
          : !viewer.isPlayer && !viewer.isAdmin
            ? <section className="login-card">
              <div className="login-icon"><ShieldAlert size={28} /></div>
              <h2>Det här kontot har inte tillgång</h2>
              <p>Be en vuxen lägga till din e-postadress i spelets spelarlista.</p>
            </section>
            : <div className="workspace">
              {viewer.isPlayer && game && <section className="game-card">
                <div className="game-heading">
                  <div><span className="eyebrow">DIN MATTEUTMANING</span><h2>{game.isPlaying ? "Vad blir svaret?" : "Redo att spela?"}</h2></div>
                  <div className="score-pill"><Trophy size={20} /><span><strong>{game.points}</strong><small>POÄNG</small></span></div>
                </div>

                {game.isPlaying && game.question
                  ? <div className="question-area">
                    <div className="question-card">
                      <span className="question-label">FRÅGA VÄRD {game.question.points} {game.question.points === 1 ? "POÄNG" : "POÄNG"}</span>
                      <div className="question">{game.question.left}<span>×</span>{game.question.right}<span>=</span><b>?</b></div>
                    </div>
                    <form className="answer-form" onSubmit={sendAnswer}>
                      <label htmlFor="answer">Skriv ditt svar</label>
                      <div className="answer-row">
                        <input id="answer" inputMode="numeric" pattern="[0-9]*" autoComplete="off" maxLength={3} value={answer} onChange={(event) => setAnswer(event.target.value.replace(/\D/g, ""))} aria-label="Ditt svar" />
                        <button className="button button-primary" type="submit" disabled={busy || !answer}><Check size={19} /> Svara</button>
                      </div>
                    </form>
                  </div>
                  : game.isPlaying
                    ? <div className="result-area">
                      {lastResult && <div className={`answer-result${lastResult.correct ? " correct" : " incorrect"}`}>
                        <strong>{lastResult.correct ? "Helt rätt! Snyggt jobbat!" : "Inte riktigt den här gången."}</strong>
                        <span>{lastResult.correct ? `Du fick ${lastResult.earnedPoints} poäng!` : `Rätt svar var ${lastResult.correctAnswer}.`}</span>
                      </div>}
                      <button className="button button-primary next-button" onClick={requestNextQuestion} disabled={busy}>Nästa fråga <ArrowRight size={18} /></button>
                    </div>
                    : <div className="start-area">
                      <p>Varje rätt svar ger 1–3 poäng. Klurigare tal ger fler poäng.</p>
                      <button className="button button-primary" onClick={beginGame} disabled={busy}><Sparkles size={19} /> Börja spela</button>
                    </div>}

                <div className="game-stats"><span><Check size={15} /> {game.correctAnswers} rätt</span><span>{game.answeredQuestions} {game.answeredQuestions === 1 ? "fråga" : "frågor"} besvarade</span></div>
                <p className="game-rule"><ShieldAlert size={15} /> Om du lämnar sidan mitt i ett spel avslutas rundan och upp till 2 poäng dras av.</p>
              </section>}

              {viewer.isPlayer && <section className="rewards-section">
                <div className="section-heading"><div><span className="eyebrow">SPARA DINA POÄNG</span><h2>Välj din belöning</h2></div><Gift size={25} /></div>
                <div className="rewards-grid">
                  {rewards.filter((reward) => reward.active).map((reward) => {
                    const canAfford = (game?.points ?? 0) >= reward.cost;
                    return <article className={`reward-card${canAfford ? " affordable" : ""}`} key={reward.id}>
                      <div className="reward-icon"><Gift size={22} /></div>
                      <h3>{reward.name}</h3>
                      <div className="reward-cost"><Star size={16} fill="currentColor" /> {reward.cost} poäng</div>
                      <button className="button button-redeem" onClick={() => buyReward(reward)} disabled={!canAfford || busy}>{canAfford ? "Lös in poäng" : `Saknar ${reward.cost - (game?.points ?? 0)}`}</button>
                    </article>;
                  })}
                  {!rewards.some((reward) => reward.active) && <p className="empty-message">Belöningar kommer snart! Fråga en vuxen. ✨</p>}
                </div>
              </section>}

              {viewer.isAdmin && <section className="admin-section">
                <div className="section-heading"><div><span className="eyebrow">VUXENLÄGE</span><h2>Hantera belöningar</h2></div><ShieldAlert size={25} /></div>
                <form className="reward-form" onSubmit={saveReward}>
                  <label className="form-field reward-name-field"><span>Namn på belöningen</span><input maxLength={48} value={rewardDraft.name} onChange={(event) => setRewardDraft((current) => ({ ...current, name: event.target.value }))} placeholder="Till exempel JumpYard" required /></label>
                  <label className="form-field reward-cost-field"><span>Poängpris</span><input type="number" min={1} max={500} step={1} value={rewardDraft.cost} onChange={(event) => setRewardDraft((current) => ({ ...current, cost: Number(event.target.value) }))} required /></label>
                  <label className="active-checkbox"><input type="checkbox" checked={rewardDraft.active} onChange={(event) => setRewardDraft((current) => ({ ...current, active: event.target.checked }))} /> Visas i spelet</label>
                  <div className="form-actions"><button className="button button-primary" type="submit" disabled={busy}>{editingRewardId ? <Pencil size={16} /> : <Plus size={18} />}{editingRewardId ? " Spara ändringar" : " Lägg till belöning"}</button>
                    {editingRewardId && <button className="button button-secondary" type="button" onClick={() => { setEditingRewardId(""); setRewardDraft(emptyReward()); }}>Avbryt</button>}</div>
                </form>
                <div className="admin-reward-list">
                  {rewards.map((reward) => <div className="admin-reward" key={reward.id}>
                    <span className="admin-reward-name">{reward.name}<small>{reward.cost} poäng · {reward.active ? "Visas" : "Dold"}</small></span>
                    <button className="icon-button" onClick={() => editReward(reward)} aria-label={`Ändra ${reward.name}`}><Pencil size={17} /></button>
                    <button className="icon-button danger" onClick={() => removeReward(reward)} aria-label={`Ta bort ${reward.name}`}><Trash2 size={17} /></button>
                  </div>)}
                  {!rewards.length && <p className="empty-message">Lägg till första belöningen här ovanför.</p>}
                </div>
                <div className="redemption-log">
                  <h3>Senast inlösta belöningar</h3>
                  {redemptions.length
                    ? redemptions.slice(0, 10).map((item) => <div className="redemption-row" key={item.id}><span>{item.rewardName}<small>{item.email}</small></span><strong>{item.cost} p</strong><time>{new Date(item.redeemedAt).toLocaleDateString("sv-SE")}</time></div>)
                    : <p className="empty-message">Inga poäng har lösts in ännu.</p>}
                </div>
              </section>}

              {error && <div className="alert" role="alert">{error}<button onClick={() => setError("")} aria-label="Stäng felmeddelande"><X size={17} /></button></div>}
              {notice && <div className="success-message" role="status">{notice}<button onClick={() => setNotice("")} aria-label="Stäng meddelande"><X size={17} /></button></div>}
            </div>}
    </main>

    <footer className="footer"><span className="footer-brand">Mattespelet <Sparkles size={15} /></span><span>RÄKNA · SAMLA · DRÖM</span><span>© {new Date().getFullYear()}</span></footer>
  </div>;
}

function messageOf(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}
