// Flying Bases (formerly Machine Builder) - drivable machines that leave the tile grid.
//
//  * A machine is a hull element (core / storage) plus every block that was placed in the machine
//    build mode (or moved to the "machine layer" with Y) and is attached to the hull.
//  * Normal state ("fly"): the blocks are taken off the world grid and live in a private "pocket world"
//    (a separate tile array that is swapped in while the machine is updated and drawn). Their original game
//    logic keeps running there (conveyors, drills, turrets ...), while the machine moves and turns freely.
//  * Build mode (G, state "land"): the machine is put back on the grid, facing up, and edited like usual blocks.
//
// Logic runs everywhere; UI, drawing and input run only on a client (not on a headless server).

var MOD = "flying-bases-fork";
var TS = 8;                   // world units per tile
var DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]]; // rotation index -> tile step
var MAX_MACHINE_TILES = 12000;
var MAX_EXTENT = 300;         // maximal machine width/height in tiles
var POCKET_MARGIN = 3;
var TAG = "mb-machines2";     // key inside the save: kept, so saves of the old "Machine Builder" still load

// ---- boosters (engines) -----------------------------------------------------------------------------
// Thrust is counted in "rocket booster units": one rocket booster = 1.
var BASE_BOOSTER_POWER = 45;      // tiles/s per machine tile, one rocket booster (was 30 -> now 1.5x faster)
var ENERGY_THRUST = 4;            // energy booster (2x2) = 4 rocket boosters on power alone (was 8: now half, a liquid brings it back)
var ENERGY_USE = 1.5;   // power units per tick = 90 power units / second
var 2ENERGY_USE = 6;   
var FUEL_BURN_TICKS = 8 * 60;     // one fuel item lasts 8 seconds of engine work
var FUEL_ITEM_CAPACITY = 20;
var FUEL_WEAKEN = 3;              // the fuel booster is 3 times weaker than it was (cryofluid brings the old thrust back)
// Liquid boost of the engines (an optional input: the engine also works without it, only weaker).
// energy booster: 10 units of liquid per 5 seconds of work, water x2, cryofluid x2.5 of the thrust
var ENERGY_LIQUID_USE = 10 / (5 * 60);   // liquid units per tick of work
var ENERGY_WATER_MULT = 2;
var ENERGY_CRYO_MULT = 2.5;
var ENERGY_LIQUID_CAPACITY = 20;
var 2ENERGY_LIQUID_CAPACITY = 20;
// fuel booster: 60 units of liquid per burnt fuel item (= per 8 seconds of work), water x1.25, cryofluid x3 of the thrust
var FUEL_LIQUID_PER_ITEM = 60;
var FUEL_LIQUID_USE = FUEL_LIQUID_PER_ITEM / FUEL_BURN_TICKS;
var FUEL_WATER_MULT = 1.25;
var FUEL_CRYO_MULT = 3;
var FUEL_LIQUID_CAPACITY = 120;
// 4x4 reactor booster: thorium + required cryofluid, high thrust, explodes without cryo or on death
var REACTOR_THRUST = 48;
var REACTOR_THORIUM_TICKS = 6 * 60;   // 1 thorium per 6 seconds of work
var REACTOR_ITEM_CAPACITY = 15;
var REACTOR_CRYO_USE = 5 / 60;        // 5 cryo/sec while working
var REACTOR_LIQUID_CAPACITY = 200;
var REACTOR_HEAT_TICKS = 4 * 60;      // seconds without cryo while thrusting before boom
var REACTOR_EXPLOSION_RADIUS = 16;
var REACTOR_EXPLOSION_DAMAGE = 4500;
var SMOKE_REACTOR_PER_SEC = 4;
// falling: a machine without any thrust, or without a hull, does not vanish: it falls (see startFall / crashMachine)
var FALL_NOTHRUST_TICKS = 150;     // no thrust at all for 2.5 s: the fall begins (a short blink of the power does not drop a ship)
var FALL_BASE_TICKS = 100;         // length of the fall of a light machine; heavier ones fall longer (+0.8 tick per cell)
var FALL_MAX_TICKS = 220;
var FALL_GROUND_DMG = 800;         // damage to every building under the machine at the hit, plus FALL_GROUND_PER_CELL per cell
var FALL_GROUND_PER_CELL = 30;
var FALL_GROUND_MAX = 25000;
var PULSE_TICKS = 34;             // period of the yellow circle in the middle of a working booster
var PULSE_ALPHA_MIN = 0.8;        // the circle of a working booster blinks between 100% and 80% opacity
var GLOW_IN_TICKS = 12;           // the circle fades in over this many ticks when the engine starts
var GLOW_OUT_TICKS = 45;          // ... and fades out over this many ticks (0.75 s) when the engine stops
// smoke of a working engine: the dust of a drill (what Drill.updateEffect / drillEffect do in Mindustry), a fixed number of puffs per second
var SMOKE_ROCKET_PER_SEC = 1;     // rocket booster, like a mechanical drill: once per second
var SMOKE_ENERGY_PER_SEC = 2;     // energy booster, like a laser (electric) drill: twice per second
var SMOKE_FUEL_PER_SEC = 3;       // fuel booster, like a pneumatic drill: three times per second
// the old Machine Builder block names -> new ones (old saves with flying machines)
var LEGACY_BLOCKS = {"machine-builder-wheel": "flying-bases-rocket-booster", "fling-bases-rocket-booster": "flying-bases-rocket-booster", "fling-bases-energy-booster": "flying-bases-energy-booster", "fling-bases-fuel-booster": "flying-bases-fuel-booster", "fling-bases-reactor-booster": "flying-bases-reactor-booster", "fling-bases-ship-control": "flying-bases-ship-control"};


// ---------------------------------------------------------------------------
//  safety: an error inside the mod must never crash the game, it is logged instead
// ---------------------------------------------------------------------------
var errCount = {};
function logErr(where, e){
    var key = where + ":" + e;
    errCount[key] = (errCount[key] || 0) + 1;
    if(errCount[key] <= 3) Log.err("[mb] error in " + where + ": " + e + (e && e.stack ? "\n" + e.stack : ""));
}
function safe(where, fn){
    return function(){
        try{
            return fn.apply(this, arguments);
        }catch(e){
            logErr(where, e);
        }
    };
}
function onEvent(type, fn){ Events.on(type, safe("event " + type, fn)); }
function runEvent(trigger, fn){ Events.run(trigger, safe("trigger " + trigger, fn)); }

// ---------------------------------------------------------------------------
//  settings helpers
// ---------------------------------------------------------------------------
function boosterPower(){
    return Core.settings == null ? BASE_BOOSTER_POWER : Core.settings.getInt("mb-booster-power", BASE_BOOSTER_POWER);
}
function autoTurn(){
    return Core.settings == null ? true : Core.settings.getBool("mb-autoturn", true);
}

function bundle(key, a, b, c){
    try{
        if(a === undefined) return Core.bundle.get(key);
        return Core.bundle.format(key, a, b === undefined ? "" : b, c === undefined ? "" : c);
    }catch(e){
        return key;
    }
}

var FALL_MSGS = {"mb.msg.falling": true, "mb.msg.falling.hull": true, "mb.msg.crashed": true, "mb.msg.wreck": true, "mb.msg.sunk": true, "mb.msg.crashdead": true};
/** who drives a machine now: used to tell the fall / crash to the right players */
function driversOf(m){
    var pls = [];
    for(var rk in remotes) if(remotes[rk].m === m) pls.push(remotes[rk].pl);
    return {local: poss != null && poss.m === m, pls: pls, team: m.team};
}
function sayDrivers(d, key){
    var saved = ctxPl;
    try{
        d.pls.forEach(pl => { ctxPl = pl; say(key); });
        // the others of the same team hear it too (a machine that falls or crashes is not a private matter of its driver)
        if(isNetHost() && d.team != null){
            try{
                Groups.player.each(cons(pl => {
                    if(pl == null || pl === Vars.player || d.pls.indexOf(pl) >= 0) return;
                    if(pl.team().id !== d.team.id) return;
                    ctxPl = pl;
                    say(key);
                }));
            }catch(eT){ logErr("say team", eT); }
        }
        ctxPl = null;
        if(d.local || d.pls.length == 0) say(key);        // a lone host (or the log of a server) hears it too
    }finally{ ctxPl = saved; }
}

function say(key, a, b, c){
    // the messages of the ships (go / done / load / unload ... and the fall) can be turned off in the settings
    if((key.indexOf("mb.msg.ship") == 0 || FALL_MSGS[key] === true) && Core.settings != null && !Core.settings.getBool("mb-ship-msgs", true)) return;
    if(ctxPl != null && ctxPl !== Vars.player){
        try{
            Packages.mindustry.gen.Call.clientPacketReliable(ctxPl.con, "mb-msg", [key, a === undefined ? "" : a, b === undefined ? "" : b, c === undefined ? "" : c].join("~"));
        }catch(e){ /* the message is lost, nothing else */ }
        return;
    }
    var text = bundle(key, a === undefined ? a : "" + a, b === undefined ? b : "" + b, c === undefined ? c : "" + c);
    if(Vars.headless){
        Log.info("[mb] " + text);
    }else{
        Vars.ui.showInfoToast(text, 2.5);
    }
}

// ---------------------------------------------------------------------------
//  state
// ---------------------------------------------------------------------------
var machines = [];          // all machines
var cellIndex = {};         // landed machines: covered real tile pos -> machine
var partIndex = {};         // flying machines: building id -> machine
var nextId = 1;
var busy = false;           // true while we ourselves change real tiles
var inPocketOp = 0;         // >0 while world.tiles is swapped to a pocket
var poss = null;            // { m } while the local player drives a machine
var buildMode = false;      // the machine build mode (G) of THIS player (on a client: what the host says about him)
// Every player has his own build mode: the host's own is `buildMode`, the others are kept here (player id -> true).
var bmRemote = {};
function localPid(){ return Vars.player == null ? -1 : Vars.player.id; }
function inBuild(pid){
    if(pid == null) return false;
    if(Vars.player != null && pid === Vars.player.id) return buildMode;
    return bmRemote[pid] === true;
}
function anyBuild(){
    if(buildMode) return true;
    for(var k in bmRemote) if(bmRemote[k] === true) return true;
    return false;
}
function bmOfPlayer(pl){ return pl != null && inBuild(pl.id); }
/** the player who built a block (null when it was not a player) */
function builderPid(unit){
    try{
        var pl = unit == null ? null : unit.getPlayer();
        return pl == null ? null : pl.id;
    }catch(e){ return null; }
}      // the machine build mode (G) is on
var dirty = false;          // a landed machine changed -> reconcile next update
var layoutVersion = 0;      // +1 whenever the cells of the machines change (see reindexAll): caches of the drawing depend on it
var saveDirty = false;
// Blocks that were finished in the build mode and belong to no machine yet: tile pos -> true. A schematic is built in any
// order, so most of its blocks are ready before its core / storage is. They wait here (red) until a chain of blocks
// reaches a machine (see adoptLoose); whatever is still here when the mode ends is removed, like any unattached block.
var loose = {};
// ---- multiplayer: the host (the server) runs everything; the other players send it commands (see "multiplayer commands") ----
var ctxPl = null;           // server: the player a command is being carried out for (null = the local player)
var remotes = {};           // server: player id -> {pl, m, ix, iy, spin, last, lastBody}: remote players that drive a machine
var netDriving = false;     // client: the unit of this player is the body of a machine
function actor(){ return ctxPl != null ? ctxPl : Vars.player; }
function remoteOf(m){
    for(var k in remotes) if(remotes[k].m === m) return remotes[k];
    return null;
}
function remoteOfPlayer(pl){ return pl == null ? null : (remotes[pl.id] || null); }
function isDriven(m){ return (poss != null && poss.m === m) || remoteOf(m) != null; }
function anyRemote(){ for(var k in remotes) return true; return false; }

// ---------------------------------------------------------------------------
//  new content: three boosters (engines) and the invisible machine body unit
// ---------------------------------------------------------------------------

// Per-booster state is kept by the mod (keyed by building id), the building classes below only read it.
var bstates = {};
function bstate(b){
    var s = bstates[b.id];
    if(s === undefined){
        s = {thrusting: false, working: false, glow: 0, stamp: Time.time, burn: 0, item: null, phase: (b.id % 17) * 2, smoke: -1, liqFrac: 1, overheat: 0, armed: false};
        bstates[b.id] = s;
    }
    return s;
}

// fuel of the fuel booster, weakest first (the weakest one in stock is burnt first, like in vanilla consumers)
var FUELS = [
    {item: Items.coal, mult: 30 / FUEL_WEAKEN},        // = 10 rocket boosters (30 with cryofluid)
    {item: Items.sporePod, mult: 33 / FUEL_WEAKEN},    // = 11 rocket boosters (33 with cryofluid)
    {item: Items.pyratite, mult: 40 / FUEL_WEAKEN}     // = 13.3 rocket boosters (40 with cryofluid)
];

function fuelMult(item){
    for(var i = 0; i < FUELS.length; i++){
        if(FUELS[i].item.id == item.id) return FUELS[i].mult;
    }
    return 0;
}

/** the fuel item that is burnt next, null when the booster is empty */
function nextFuel(b){
    for(var i = 0; i < FUELS.length; i++){
        if(b.items.get(FUELS[i].item) > 0) return FUELS[i].item;
    }
    return null;
}

// ---- liquid boost of the energy and fuel boosters ------------------------------------------------------
/** thrust multiplier that `liquid` gives to the booster block `blk` (1 = no boost) */
function boostMultFor(blk, liquid){
    if(liquid == null) return 1;
    var water = liquid.id == Liquids.water.id, cryo = liquid.id == Liquids.cryofluid.id;
    if(blk === energyBooster) return water ? ENERGY_WATER_MULT : (cryo ? ENERGY_CRYO_MULT : 1);
    if(blk === fuelBooster) return water ? FUEL_WATER_MULT : (cryo ? FUEL_CRYO_MULT : 1);
    if(blk === reactorBooster) return cryo ? 1 : 0;   // cryo is required coolant, not a thrust mult
    return 1;
}

/** liquid units per tick of work that the booster uses up */
function liquidUse(blk){
    if(blk === reactorBooster) return REACTOR_CRYO_USE;
    return blk === fuelBooster ? FUEL_LIQUID_USE : ENERGY_LIQUID_USE;
}

/** can the booster take this liquid from a conduit: only a boosting liquid, and never two kinds mixed in the tank */
function acceptsBoostLiquid(b, liquid){
    if(b.liquids == null) return false;
    if(b.block === reactorBooster){
        if(liquid == null || liquid.id != Liquids.cryofluid.id) return false;
        var l0 = b.liquids;
        return l0.current().id == liquid.id || l0.currentAmount() < 0.2;
    }
    if(boostMultFor(b.block, liquid) <= 1) return false;
    var l = b.liquids;
    return l.current().id == liquid.id || l.currentAmount() < 0.2;
}

/** the boosting liquid that is in the tank right now (null = the tank is empty or holds something useless) */
function boostLiquidOf(b){
    if(b.liquids == null) return null;
    var liq = b.liquids.current();
    if(liq == null || b.liquids.get(liq) <= 0.0001) return null;
    // reactor booster: cryo is required coolant (mult == 1), still must be consumed
    if(b.block === reactorBooster) return liq.id == Liquids.cryofluid.id ? liq : null;
    return boostMultFor(b.block, liq) > 1 ? liq : null;
}

/** thrust multiplier of the booster from its liquid; partial while the supply is not enough for the whole tick */
function liquidMult(b){
    var liq = boostLiquidOf(b);
    if(liq == null) return 1;
    var full = boostMultFor(b.block, liq);
    var s = bstates[b.id];
    var frac = (s !== undefined && s.working) ? s.liqFrac : 1;
    return 1 + (full - 1) * frac;
}

/** a working booster uses up its liquid: called every tick while the engine really works */
function stepLiquid(b, s, delta){
    var liq = boostLiquidOf(b);
    if(liq == null){
        s.liqFrac = 1;      // nothing to use up: the next drop is used at full effect at once
        return;
    }
    var need = liquidUse(b.block) * delta;
    var take = Math.min(need, b.liquids.get(liq));
    b.liquids.remove(liq, take);
    s.liqFrac = need > 0 ? take / need : 1;
}

function fmtNum(v){
    return "" + Math.round(v * 100) / 100;
}

/** what the hover panel of a booster shows under the bars (vanilla: Building.displayConsumption): the fuel and the liquids as
 *  icons that are crossed out while the booster does not have them, like the cryofluid of a differential generator */
function boosterConsumption(b, table){
    try{
        table.left();
        if(b.block === fuelBooster){
            var fuels = new MultiReqImage();
            FUELS.forEach(f => fuels.add(new ReqImage(f.item.uiIcon, boolp(() => b.items.get(f.item) > 0))));
            table.add(fuels).size(32).padRight(14);
        }
        if(b.block === reactorBooster){
            table.add(new ReqImage(Items.thorium.uiIcon, boolp(() => b.items != null && b.items.get(Items.thorium) > 0))).size(32).padRight(8);
            table.add(new ReqImage(Liquids.cryofluid.uiIcon, boolp(() => b.liquids != null && b.liquids.get(Liquids.cryofluid) > 0.01))).size(32);
            table.add("5/s").color(Color.lightGray).padLeft(3).padRight(10);
        }else{
            [Liquids.water, Liquids.cryofluid].forEach(liq => {
                table.add(new ReqImage(liq.uiIcon, boolp(() => b.liquids != null && b.liquids.get(liq) > 0.01))).size(32);
                table.add("x" + fmtNum(boostMultFor(b.block, liq))).color(Color.lightGray).padLeft(3).padRight(10);
            });
        }
        table.row();
        table.label(prov(() => bundle("mb.booster.thrust", fmtNum(boosterThrust(b))))).color(Color.lightGray).colspan(5).left().padTop(2);
    }catch(e){
        logErr("boosterConsumption", e);
    }
}

var pulseSmall = null, pulseBig = null;

/** moves the glow of a booster towards "on" (working) or "off": quick fade-in, slow fade-out.
 *  Driven by the game clock (not by frames), so it may be called from the update and from the drawing alike. */
function stepGlow(s, working){
    var now = Time.time;
    var dt = now - s.stamp;
    s.stamp = now;
    if(dt <= 0) return;
    if(working) s.glow = Math.min(1, s.glow + dt / GLOW_IN_TICKS);
    else s.glow = Math.max(0, s.glow - dt / GLOW_OUT_TICKS);
}

/** the yellow circle in the middle of a working booster: it never goes away while the engine works, it only blinks
 *  between 100% and 80% opacity; when the engine stops (or starts) the whole thing fades smoothly with `glow` */
function drawPulse(b, st, big){
    var reg;
    if(big){
        if(pulseBig == null) pulseBig = Core.atlas.find(MOD + "-pulse-big");
        reg = pulseBig;
    }else{
        if(pulseSmall == null) pulseSmall = Core.atlas.find(MOD + "-pulse");
        reg = pulseSmall;
    }
    var wave = 0.5 + 0.5 * Math.sin((Time.time + st.phase) / PULSE_TICKS * 2 * Math.PI);   // 0 .. 1, smooth
    var blink = PULSE_ALPHA_MIN + (1 - PULSE_ALPHA_MIN) * wave;                           // 0.8 .. 1
    var g = st.glow;
    g = g * g * (3 - 2 * g);                                                              // smoothstep: soft start and end of the fade
    Draw.color(Color.white);
    Draw.alpha(blink * g);
    Draw.rect(reg, b.x, b.y, reg.width * TS / 32, reg.height * TS / 32);
    Draw.color();
}

// ---- heat effect of the reactor booster (heat = 0 .. 1 of REACTOR_HEAT_TICKS without cryofluid) ----
var HEAT_C0 = Color.valueOf("b3261e");      // dark red: it starts to warm up
var HEAT_C1 = Color.valueOf("ff7a1a");      // orange
var HEAT_C2 = Color.valueOf("fff2b0");      // white-yellow: about to blow
var HEAT_TMP = new Color();
var HEAT_WARN = Color.valueOf("ff2a2a");

function heatTint(h){
    if(h < 0.5) return HEAT_TMP.set(HEAT_C0).lerp(HEAT_C1, h * 2);
    return HEAT_TMP.set(HEAT_C1).lerp(HEAT_C2, (h - 0.5) * 2);
}

function drawReactorHeat(b, st, size){
    var heat = Mathf.clamp(st.overheat / REACTOR_HEAT_TICKS, 0, 1);
    if(heat < 0.02) return;
    var w = size * TS, x = b.x, y = b.y;
    // the pulse gets faster as the heat grows: about 1.5 per second at the start, 6 at the end
    var wave = 0.5 + 0.5 * Math.sin(Time.time * (0.16 + heat * 0.42) + st.phase);

    // 1. the block itself glows: its own picture, added to what is on screen (a red film is not a glow)
    var ADD = Packages.arc.graphics.Blending.additive;
    try{
        Draw.blend(ADD);
        Draw.color(heatTint(heat));
        Draw.alpha(heat * (0.30 + 0.30 * wave));
        Draw.rect(b.block.region, x, y, w, w);
        Draw.alpha(heat * heat * 0.30 * (0.5 + 0.5 * wave));        // a soft halo around it, only when it is really hot
        Draw.rect(b.block.region, x, y, w * 1.10, w * 1.10);
        // 2. the core: a round glow in the middle, bigger and brighter with the heat
        if(pulseBig == null) pulseBig = Core.atlas.find(MOD + "-pulse-big");
        var k = (0.55 + 0.55 * heat) * (0.92 + 0.08 * wave);
        Draw.color(heatTint(Math.min(1, heat + 0.2)));
        Draw.alpha(Math.min(1, heat * 1.2) * (0.55 + 0.45 * wave));
        Draw.rect(pulseBig, x, y, pulseBig.width * TS / 32 * k, pulseBig.height * TS / 32 * k);
    }finally{
        Draw.blend();
        Draw.color();
    }

    // 3. the glow lights the ground around, if the game has lights on
    try{ Drawf.light(x, y, w * (1.2 + heat * 1.8), heatTint(heat), heat * 0.7); }catch(eL){ /* no light then */ }

    // 4. the red frame blinks from 60% of the heat: the last seconds before the boom
    if(heat > 0.6){
        var blink = Math.sin(Time.time * (0.25 + heat * 0.5)) > 0;
        if(blink){
            Lines.stroke(1.2);
            Draw.color(HEAT_WARN);
            Draw.alpha(0.55 + 0.4 * heat);
            Lines.square(x, y, w / 2 + 0.5);
            Draw.color();
            Lines.stroke(1);
        }
    }

    // 5. a small heat bar above the block: yellow to red, white at the very end
    var bw = w * 0.9, by = y + w / 2 + 3.5;
    Draw.color(Color.black);
    Draw.alpha(0.6);
    Draw.rect(Core.atlas.white(), x, by, bw + 1.5, 3.2);
    Draw.color(heat > 0.9 && Math.sin(Time.time * 0.8) > 0 ? Color.white : heatTint(heat));
    Draw.alpha(1);
    Draw.rect(Core.atlas.white(), x - bw / 2 + bw * heat / 2, by, bw * heat, 2);
    Draw.color();

    // 6. electric arcs jump from the block in the last third
    if(heat > 0.66 && Math.random() < 0.25 + heat * 0.5){
        var arcs = heat > 0.9 ? 2 : 1;
        for(var a = 0; a < arcs; a++){
            var ang = Math.random() * Math.PI * 2;
            var px = x + Math.cos(ang) * w * 0.42, py = y + Math.sin(ang) * w * 0.42;
            Lines.stroke(1);
            Draw.color(heat > 0.85 ? HEAT_C2 : HEAT_C1);
            Draw.alpha(0.9);
            for(var seg = 0; seg < 3; seg++){
                var na = ang + randRange(0.55);
                var nx = px + Math.cos(na) * (3 + Math.random() * 4), ny = py + Math.sin(na) * (3 + Math.random() * 4);
                Lines.line(px, py, nx, ny);
                px = nx; py = ny;
            }
        }
        Draw.color();
    }

    // 7. particles, sparks, shake and the alarm: counted in time, not in frames (and once per frame, however often it is drawn)
    if(Vars.headless || st.fxT === Time.time) return;
    var dt = st.fxT === undefined ? 1 : Math.min(4, Time.time - st.fxT);
    st.fxT = Time.time;
    var r = w * 0.38;
    // smoke: 2 per second at the start, 14 at the end
    st.fxSmoke = (st.fxSmoke || 0) + dt * (2 + 12 * heat) / 60;
    while(st.fxSmoke >= 1){
        st.fxSmoke -= 1;
        try{ Fx.reactorsmoke.at(x + randRange(r), y + randRange(r)); }catch(e1){
            try{ Fx.smoke.at(x + randRange(r), y + randRange(r)); }catch(e2){ /* no smoke then */ }
        }
    }
    // sparks and flames from 35%: up to 24 per second
    if(heat > 0.35){
        st.fxSpark = (st.fxSpark || 0) + dt * 24 * heat * heat / 60;
        while(st.fxSpark >= 1){
            st.fxSpark -= 1;
            try{ Fx.hitFlameSmall.at(x + randRange(r), y + randRange(r), Math.random() * 360); }catch(e3){
                try{ Fx.fuelburn.at(x + randRange(r), y + randRange(r)); }catch(e4){ /* no sparks then */ }
            }
        }
    }
    // the ground shakes more and more
    if(heat > 0.5 && (Math.floor(Time.time) % 6) < dt){
        try{ Effect.shake(heat * 1.6, 5, x, y); }catch(e5){ /* no shake then */ }
    }
    // the alarm: every 50 ticks from 55% of the heat
    if(heat > 0.55){
        st.fxSnd = (st.fxSnd || 0) + dt;
        if(st.fxSnd >= 50){
            st.fxSnd = 0;
            try{ Sounds.alarm.at(x, y); }catch(e6){
                try{ Sounds.alarmloop.at(x, y); }catch(e7){ /* no sound then */ }
            }
        }
    }
}

function drawBooster(b){
    var s = b.block.size;
    Draw.rect(b.block.region, b.x, b.y, s * TS, s * TS);
    var st = bstates[b.id];
    if(st === undefined) return;
    stepGlow(st, st.working);     // a landed machine has no update of its own: its glow fades out while it is drawn
    if(st.glow > 0.01) drawPulse(b, st, s >= 3);
    // reactor overheat: glow, arcs, sparks, a heat bar and a warning, all growing with the heat
    if(b.block === reactorBooster && st.overheat > 1){
        try{ drawReactorHeat(b, st, s); }catch(eHeat){ try{ Draw.blend(); Draw.color(); }catch(e0){ /* nothing */ } }
    }
}

function defBooster(name, size, health, reqs, buildTypeFn){
    var blk = extend(Block, name, {
        canPlaceOn(tile, team, rotation){
            // boosters make sense only as a part of a machine under construction
            return anyBuild();
        },
        drawPlanRegion(plan, list){
            Draw.rect(this.region, plan.drawx(), plan.drawy(), size * TS, size * TS);
        }
    });
    blk.requirements = reqs;
    blk.category = Category.units;
    blk.buildVisibility = BuildVisibility.shown;
    blk.size = size;
    blk.health = health;
    blk.solid = true;
    blk.update = true;
    blk.destructible = true;
    blk.rotate = false;
    blk.alwaysUnlocked = true;
    blk.buildType = prov(buildTypeFn);
    return blk;
}

// 1x1: plain rocket booster (the old wheel), thrust 1
var rocketBooster = defBooster("rocket-booster", 1, 160,
    ItemStack.with(Items.copper, 20, Items.lead, 10, Items.graphite, 5),
    () => extend(Building, {
        draw(){ drawBooster(this); }
    }));

// 3x3: energy booster, thrust 32 rocket boosters (water x2, cryofluid x2.5), uses 90 power units / second while the engine works
var energyBooster = defBooster("2energy-booster", 3, 6400,
    ItemStack.with(Items.copper, 1000, Items.lead, 500, Items.silicon, 300, Items.plastanium, 200),
    () => extend(Building, {
        draw(){ drawBooster(this); },
        // power is requested only while the engine really works (the machine is being driven)
        shouldConsume(){
            var s = bstates[this.id];
            return s !== undefined && s.thrusting;
        },
        acceptLiquid(source, liquid){
            return acceptsBoostLiquid(this, liquid);
        },
        displayConsumption(table){
            boosterConsumption(this, table);
        }
    }));
energyBooster.hasPower = true;
energyBooster.consumePower(2ENERGY_USE);
energyBooster.hasLiquids = true;
energyBooster.liquidCapacity = 2ENERGY_LIQUID_CAPACITY;

// 2x2: energy booster, thrust 4 rocket boosters (water x2, cryofluid x2.5), uses 90 power units / second while the engine works
var energyBooster = defBooster("energy-booster", 2, 640,
    ItemStack.with(Items.copper, 100, Items.lead, 50, Items.silicon, 30, Items.plastanium, 20),
    () => extend(Building, {
        draw(){ drawBooster(this); },
        // power is requested only while the engine really works (the machine is being driven)
        shouldConsume(){
            var s = bstates[this.id];
            return s !== undefined && s.thrusting;
        },
        acceptLiquid(source, liquid){
            return acceptsBoostLiquid(this, liquid);
        },
        displayConsumption(table){
            boosterConsumption(this, table);
        }
    }));
energyBooster.hasPower = true;
energyBooster.consumePower(ENERGY_USE);
energyBooster.hasLiquids = true;
energyBooster.liquidCapacity = ENERGY_LIQUID_CAPACITY;

// 3x3: fuel booster, burns one item per 8 seconds of work: coal = 10, spore pod = 11, pyratite = 13.3 rocket boosters
// (water x1.25, cryofluid x3 = the old thrust and more); the liquid is used up at 60 units per burnt item
var fuelBooster = defBooster("fuel-booster", 3, 1440,
    ItemStack.with(Items.copper, 300, Items.lead, 400, Items.graphite, 100, Items.plastanium, 100, Items.titanium, 200),
    () => extend(Building, {
        draw(){ drawBooster(this); },
        acceptItem(source, item){
            return fuelMult(item) > 0 && this.items.get(item) < FUEL_ITEM_CAPACITY;
        },
        getMaximumAccepted(item){
            return FUEL_ITEM_CAPACITY;
        },
        acceptLiquid(source, liquid){
            return acceptsBoostLiquid(this, liquid);
        },
        displayConsumption(table){
            boosterConsumption(this, table);
        }
    }));
fuelBooster.hasItems = true;
fuelBooster.itemCapacity = FUEL_ITEM_CAPACITY;
fuelBooster.hasLiquids = true;
fuelBooster.liquidCapacity = FUEL_LIQUID_CAPACITY;
fuelBooster.unloadable = true;       // unloaders may take the fuel out of the booster (and, as before, put it in)
try{ fuelBooster.acceptsItems = true; }catch(e){ /* field name differs between versions: harmless */ }

// 4x4: reactor booster — thorium + required cryofluid, thrust 32, overheats/explodes without cryo
var reactorBooster = defBooster("reactor-booster", 4, 2800,
    ItemStack.with(
        Items.copper, 700, Items.lead, 600, Items.silicon, 250, Items.titanium, 350,
        Items.thorium, 250, Items.plastanium, 180, Items.surgeAlloy, 100, Items.phaseFabric, 40
    ),
    () => extend(Building, {
        draw(){ drawBooster(this); },
        acceptItem(source, item){
            return item == Items.thorium && this.items.get(item) < REACTOR_ITEM_CAPACITY;
        },
        getMaximumAccepted(item){
            return item == Items.thorium ? REACTOR_ITEM_CAPACITY : 0;
        },
        acceptLiquid(source, liquid){
            return acceptsBoostLiquid(this, liquid);
        },
        displayConsumption(table){
            boosterConsumption(this, table);
        }
    }));
reactorBooster.hasItems = true;
reactorBooster.itemCapacity = REACTOR_ITEM_CAPACITY;
reactorBooster.hasLiquids = true;
reactorBooster.liquidCapacity = REACTOR_LIQUID_CAPACITY;
reactorBooster.unloadable = true;
try{ reactorBooster.acceptsItems = true; }catch(e){ /* ok */ }
try{
    reactorBooster.explosionRadius = REACTOR_EXPLOSION_RADIUS;
    reactorBooster.explosionDamage = REACTOR_EXPLOSION_DAMAGE;
    reactorBooster.explosionShake = 8;
    reactorBooster.explosionShakeDuration = 20;
    // match thorium reactor look/sound as far as the API allows
    var tr = Blocks.thoriumReactor;
    if(tr != null){
        if(tr.explodeEffect != null) reactorBooster.explodeEffect = tr.explodeEffect;
        if(tr.explodeSound != null) reactorBooster.explodeSound = tr.explodeSound;
    }
}catch(e){ /* fields may differ */ }

// ---------------------------------------------------------------------------
//  ship control: a block that tells the machine which ore or liquid to bring home (see shipTick)
// ---------------------------------------------------------------------------
var SHIP_FULL = 0.85;                       // default: the machine stops mining and carries its load home when it holds this share of its maximum
var SHIP_RESTART = 0.1;                     // a machine that holds less than this share of its maximum goes for the next load
var SHIP_REGION = 24;                       // tiles: how far around the nearest vein tile the autopilot looks for the richest spot
var SHIP_HUGE = 6000;                       // more ore tiles than this: the field is taken as one lump
var SHIP_PERIOD = 15;                       // ticks between two checks of the stock of a machine
var SHIP_IDLE = Color.valueOf("8a929b");    // the top of a control block that is not set to anything yet
var shipCfg = {};                           // building id -> the Item or Liquid a ship control block is set to
var shipOpt = {};                           // building id -> the other settings of a ship control block (see shipOptOf)
var shipMap = null;                         // the ores and liquids of the map (see shipSourceMap), made again for every world
var shipTop = null;

/** a tile as one number, like Point2.pack / Point2.x / Point2.y but without a call into Java for every tile: the lists of
 *  ore tiles of a big map have tens of thousands of entries and are walked often */
function pk(x, y){ return ((x & 0xFFFF) << 16) | (y & 0xFFFF); }
function pkx(k){ return k >> 16; }
function pky(k){ return k & 0xFFFF; }

function isLiquidRes(v){ return v != null && v instanceof Packages.mindustry.type.Liquid; }
function isShipControl(b){ return b != null && b.block === shipControl; }
function isPumpBlock(blk){ return blk != null && typeof blk.pumpAmount === "number"; }

function shipSetCfg(b, v){
    // apply locally so the UI reacts immediately; on a client also tell the host
    shipCfg[b.id] = v == null ? null : v;
    saveDirty = true;
    if(Vars.net.client()){
        var code = v == null ? "" : shipCode(v);
        netCmd("shipcfg|" + b.tile.x + "|" + b.tile.y + "|" + code);
    }
}

/** the settings of a control block besides the resource: full (the share of the stores at which the machine stops and goes
 *  home), restart (below this share it goes for the next load), home (carry the load to the core), all (unload every item,
 *  not only the chosen one; an item that fills up also sends the machine home), best (look for the richest spot) */
function shipOptOf(b){
    var o = shipOpt[b.id];
    if(o === undefined){
        o = shipOpt[b.id] = {full: SHIP_FULL, restart: SHIP_RESTART, home: true, all: true, best: true, supply: false, dx: -1, dy: -1, sx: -1, sy: -1};
    }
    return o;
}
function shipOptSet(b, key, v){
    // apply locally so the UI reacts immediately; on a client also tell the host
    shipOptOf(b)[key] = v;
    saveDirty = true;
    if(Vars.net.client()){
        var val = (typeof v === "boolean") ? (v ? "1" : "0") : String(v);
        netCmd("shipopt|" + b.tile.x + "|" + b.tile.y + "|" + key + "|" + val);
    }
}
function shipOptCode(b){
    var o = shipOptOf(b);
    return [Math.round(o.full * 100), Math.round(o.restart * 100), o.home ? 1 : 0, o.all ? 1 : 0, o.best ? 1 : 0, o.supply ? 1 : 0, o.dx, o.dy, o.sx, o.sy];
}
function shipOptFrom(b, a){
    if(a == null || a.length < 5) return;
    var o = shipOptOf(b);
    o.full = a[0] / 100; o.restart = a[1] / 100;
    o.home = a[2] == 1; o.all = a[3] == 1; o.best = a[4] == 1;
    if(a.length >= 8){ o.supply = a[5] == 1; o.dx = a[6]; o.dy = a[7]; }
    if(a.length >= 10){ o.sx = a[8]; o.sy = a[9]; }
}

/** a setting as text for the save: "i:copper" (an item) or "l:water" (a liquid) */
function shipCode(v){ return (isLiquidRes(v) ? "l:" : "i:") + v.name; }

function shipFromCode(s){
    if(s == null || s.length < 3) return null;
    return Vars.content.getByName(s.charAt(0) == "l" ? ContentType.liquid : ContentType.item, s.substring(2));
}

/** the settings of the control blocks of a landed machine, saved with the machine (its flying parts keep theirs in serializePart) */
function shipSaveList(blds){
    var out = [];
    blds.forEach(b => {
        if(isShipControl(b)) out.push([b.tile.x, b.tile.y, shipCfg[b.id] != null ? shipCode(shipCfg[b.id]) : "", shipOptCode(b)]);
    });
    return out;
}

var shipControl = extend(Block, "ship-control", {
    canPlaceOn(tile, team, rotation){
        // like the boosters: only as a part of a machine under construction
        return anyBuild();
    },
    drawPlanRegion(plan, list){
        Draw.rect(this.region, plan.drawx(), plan.drawy(), this.size * TS, this.size * TS);
    }
});
shipControl.requirements = ItemStack.with(Items.copper, 50, Items.lead, 300, Items.silicon, 120);
shipControl.category = Category.units;
shipControl.buildVisibility = BuildVisibility.shown;
shipControl.size = 2;
shipControl.health = 480;   // was 120 — too low for a 2×2 block; matched energy booster scale so the bar no longer looks "dead"
shipControl.solid = true;
shipControl.destructible = true;
shipControl.rotate = false;
shipControl.alwaysUnlocked = true;
shipControl.configurable = true;
shipControl.buildType = prov(() => extend(Building, {
    // Ensure health/maxHealth stay valid after pocket move / schematic paste (fixes solid-red "Прочность" bar)
    created(){
        this.super$created();
        if(this.maxHealth <= 0 || isNaN(this.maxHealth)) this.maxHealth = this.block.health;
        if(this.health <= 0 || isNaN(this.health)) this.health = this.maxHealth;
    },
    draw(){ drawShipControl(this); },
    buildConfiguration(table){
        try{
            buildShipPicker(this, table);
        }catch(e){
            logErr("ship control UI", e);
            table.clearChildren();
            table.add("[scarlet]UI error (see log)[]").pad(8);
            table.row();
            table.add(String(e)).wrap().width(280).pad(4);
        }
    },
    // The setting (the ore / liquid) as the GAME reads it: a copied area and a saved schematic take it from here
    // (Schematics.create), so do "pick block", the copy of the config of one building to another and the rebuild of a
    // destroyed block. Pasting gives it back through the config handlers below. Without this the game saw no setting at all.
    config(){
        var v = shipCfg[this.id];
        return v == null ? null : v;
    }
}));
try{
    shipControl.config(Packages.mindustry.type.Item, (b, v) => shipSetCfg(b, v));
    shipControl.config(Packages.mindustry.type.Liquid, (b, v) => shipSetCfg(b, v));
    shipControl.configClear(b => shipSetCfg(b, null));
}catch(e){
    Log.err("[mb] ship control config not registered: " + e);
}

/** the block (2x2): its base (picture 2), then its top (picture 1) painted with the colour of the ore / liquid it is set to */
function drawShipControl(b){
    if(shipTop == null) shipTop = Core.atlas.find(MOD + "-ship-control-top");
    var s = b.block.size * TS;
    Draw.rect(b.block.region, b.x, b.y, s, s);
    var v = shipCfg[b.id];
    Draw.color(v == null ? SHIP_IDLE : v.color);
    Draw.rect(shipTop, b.x, b.y, s, s);
    Draw.color();
}

/** the picker that opens on a control block: every ore and liquid the map has, nothing else.
 *  Settings are applied locally and, on a client, also sent to the host (shipcfg / shipopt). */
var sizeMem = {};          // key -> percent (what the + / - buttons set)
var sizeSeen = {};         // key -> the value last seen in the settings (a slider moved in the settings dialog changes it)
/** a size setting in percent (40..150). The buttons never depend on reading the settings back: the value is kept here. */
function sizeSetting(key, def){
    var cur = null;
    try{ cur = Core.settings.getInt(key, def); }catch(e){ cur = null; }
    if(cur !== null && sizeSeen[key] !== cur){ sizeSeen[key] = cur; sizeMem[key] = cur; }
    var v = sizeMem[key];
    return Mathf.clamp(v === undefined ? def : v, 40, 150);
}

/** changes a size setting by a step (percent) and returns the new value */
function stepSizeSetting(key, def, step){
    var v = Mathf.clamp(sizeSetting(key, def) + step, 40, 150) | 0;
    sizeMem[key] = v;
    try{ Core.settings.putInt(key, v); sizeSeen[key] = v; }catch(e){ logErr("size setting", e); }
    Log.info("[mb] size " + key + " = " + v);
    return v;
}

function shipUiScale(){
    return sizeSetting("mb-ship-ui-scale", 85) / 100;
}

/** The window of a ship control block.
 *  Made flexible for mobile: no rigid fixed widths that break the game's config table on Android.
 *  Content uses growX() and adapts to available space so the menu actually opens. */
function buildShipPicker(b, table){
    var K = shipUiScale();
    var rebuild = () => Core.app.post(run(() => { table.clearChildren(); buildShipPicker(b, table); }));
    var mobile = Vars.mobile;
    var FS = Math.max(0.55, (mobile ? 0.78 : 0.90) * K);
    var BH = Math.max(22, Math.round((mobile ? 30 : 34) * K));
    var ICON = Math.max(22, Math.round((mobile ? 32 : 38) * K));
    var W = Math.min(ICON * (mobile ? 7 : 8), mobile ? 280 : 320);
    var fonts = c => { try{ var l = c.get(); l.setFontScale(FS); l.setWrap(true); }catch(e){} return c; };
    var btnFont = c => { try{ var l = c.get().getLabel(); l.setFontScale(FS); l.setWrap(true); }catch(e){} return c; };

    table.clearChildren();
    table.margin(Math.max(3, Math.round(4 * K)));
    table.top().left();

    var addRow = fn => {
        var r = new Table();
        r.defaults().pad(Math.max(1, Math.round(1.5 * K)));
        fn(r);
        table.add(r).width(W).left();
        table.row();
        return r;
    };

    // Header with accent background
    var header = new Table();
    try{ header.background(Styles.black6); }catch(e){}
    header.margin(Math.max(4, Math.round(5 * K)));
    header.defaults().pad(1);
    var ht = fonts(header.add(bundle("mb.ship.title"))).growX().left();
    try{ ht.get().setColor(Pal.accent); }catch(e){}
    header.button("-", Styles.defaultt, run(() => { stepSizeSetting("mb-ship-ui-scale", 85, -10); rebuild(); })).size(BH);
    fonts(header.label(prov(() => Math.round(shipUiScale() * 100) + "%"))).width(Math.round(40 * K)).center();
    header.button("+", Styles.defaultt, run(() => { stepSizeSetting("mb-ship-ui-scale", 85, 10); rebuild(); })).size(BH);
    table.add(header).width(W).left();
    table.row();

    // thin accent line under header
    try{ table.image().color(Pal.accent).width(W).height(2).left(); table.row(); }catch(e){}

    var inner = new Table();
    inner.top().left();
    buildShipInner(b, inner, rebuild, {K: K, FS: FS, BH: BH, ICON: ICON, W: W, fonts: fonts, btnFont: btnFont, mobile: mobile});

    var maxH = Math.round(Core.graphics.getHeight() * (mobile ? 0.36 : 0.48));
    try{
        table.pane(Styles.noBarPane, inner).width(W).maxHeight(maxH).top().left();
    }catch(e){
        table.add(inner).width(W).top().left();
    }
}

function buildShipInner(b, table, rebuild, ui){
    var map = shipSourceMap();
    var opt = shipOptOf(b);
    var list = opt.supply ? shipAllItems() : map.items.concat(map.liquids);
    var K = ui.K, FS = ui.FS, BH = ui.BH, ICON = ui.ICON, W = ui.W, fonts = ui.fonts, btnFont = ui.btnFont;
    var mobile = ui.mobile === true;
    var res = shipCfg[b.id];
    var liq = res != null && isLiquidRes(res);
    var pad = Math.max(1, Math.round(1.5 * K));

    var row = fn => {
        var r = new Table();
        r.defaults().pad(pad);
        fn(r);
        table.add(r).width(W).left();
        table.row();
        return r;
    };
    var line = () => {
        try{ table.image().color(Color.valueOf("3a3a4a")).width(W).height(1).left(); table.row(); }catch(e){}
    };
    var section = key => {
        var r = new Table();
        r.defaults().pad(pad);
        // small accent bar + title
        try{ r.image().color(Pal.accent).width(3).height(Math.round(14 * K)).left().padRight(6); }catch(e){}
        var l = r.add(bundle(key)).growX().left();
        try{ l.get().setColor(Pal.accent); l.get().setFontScale(FS * 1.05); }catch(e){}
        table.add(r).width(W).left().padTop(Math.round(6 * K)).padBottom(Math.round(2 * K));
        table.row();
        line();
    };
    var btn = (r, text, style, fn) => btnFont(r.button(text, style, fn)).height(BH);

    // ---- Resource
    section("mb.ship.sec.res");
    if(list.length == 0){
        row(r => { fonts(r.add(bundle("mb.ship.nothing"))).growX().left(); });
    }
    row(r => {
        btn(r, bundle("mb.ship.none"), Styles.defaultt, run(() => shipSetCfg(b, null))).growX();
    });

    // resource icon grid with subtle background
    var grid = new Table();
    try{ grid.background(Styles.black6); }catch(e){}
    grid.margin(Math.max(2, Math.round(3 * K)));
    var cols = mobile ? 6 : 8;
    list.forEach((v, i) => {
        var ib = grid.button(new Packages.arc.scene.style.TextureRegionDrawable(v.uiIcon), Styles.clearNoneTogglei, run(() => shipSetCfg(b, v)))
            .size(ICON).pad(1).update(bt => { bt.setChecked(shipCfg[b.id] === v); });
        try{ ib.tooltip(v.localizedName); }catch(e){}
        if(i % cols == cols - 1) grid.row();
    });
    table.add(grid).width(W).left().padTop(2).padBottom(2);
    table.row();

    // selected resource highlight
    row(r => {
        var sel = shipCfg[b.id];
        var txt = "[accent]" + bundle("mb.ship.selected") + ":[] " + (sel == null ? bundle("mb.ship.none") : sel.localizedName);
        fonts(r.label(prov(() => {
            var s = shipCfg[b.id];
            return "[accent]" + bundle("mb.ship.selected") + ":[] " + (s == null ? bundle("mb.ship.none") : s.localizedName);
        }))).growX().left();
    });

    // ---- Mode (segmented control look)
    section("mb.ship.sec.mode");
    row(r => {
        r.defaults().uniformX().growX();
        btn(r, bundle("mb.ship.mode.mine"), Styles.togglet || Styles.defaultt, run(() => { shipOptSet(b, "supply", false); rebuild(); }))
            .growX().update(bt => { bt.setChecked(!opt.supply); });
        btn(r, bundle("mb.ship.mode.supply"), Styles.togglet || Styles.defaultt, run(() => { shipOptSet(b, "supply", true); rebuild(); }))
            .growX().update(bt => { bt.setChecked(opt.supply); });
    });
    row(r => {
        var hint = fonts(r.add(bundle(opt.supply ? "mb.ship.mode.supply.hint" : "mb.ship.mode.mine.hint"))).growX().left();
        try{ hint.get().setColor(Color.lightGray); }catch(e){}
    });

    // ---- Route
    section("mb.ship.sec.route");
    var route = (labelKey, defKey, kx, ky, which) => {
        row(r => {
            fonts(r.label(prov(() => "[lightgray]" + bundle(labelKey) + ":[] " + (opt[kx] >= 0 ? opt[kx] + ", " + opt[ky] : bundle(defKey)))))
                .growX().left();
            btn(r, bundle("mb.ship.choose"), Styles.defaultt, run(() => shipStartPick(b, which))).width(Math.max(64, Math.round(80 * K)));
            r.button("x", Styles.defaultt, run(() => { shipOptSet(b, kx, -1); shipOptSet(b, ky, -1); })).size(BH);
        });
    };
    if(opt.supply) route("mb.ship.from", liq ? "mb.ship.from.tank" : "mb.ship.core", "sx", "sy", "src");
    route("mb.ship.to", liq ? "mb.ship.to.tank" : "mb.ship.core", "dx", "dy", "dest");

    // ---- Parameters
    section("mb.ship.sec.params");
    var stepper = (label, key, lo, hi) => {
        var low = () => (!opt.supply && key === "full") ? Math.max(lo, Math.round(opt.restart * 100) + 5) : lo;
        var high = () => (!opt.supply && key === "restart") ? Math.min(hi, Math.round(opt.full * 100) - 5) : hi;
        row(r => {
            fonts(r.add(bundle(label))).growX().left();
            r.button("-", Styles.defaultt, run(() => shipOptSet(b, key, Math.max(low(), Math.round(opt[key] * 100) - 5) / 100))).size(BH);
            fonts(r.label(prov(() => Math.round(opt[key] * 100) + "%"))).width(Math.round(44 * K)).center();
            r.button("+", Styles.defaultt, run(() => shipOptSet(b, key, Math.min(high(), Math.round(opt[key] * 100) + 5) / 100))).size(BH);
        });
    };
    var toggle = (label, key) => {
        row(r => {
            btn(r, bundle(label), Styles.togglet || Styles.defaultt, run(() => shipOptSet(b, key, !opt[key])))
                .growX().update(bt => { bt.setChecked(opt[key]); });
        });
    };
    if(opt.supply){
        stepper("mb.ship.loadto", "full", 50, 100);
    }else{
        stepper("mb.ship.full", "full", 50, 100);
        stepper("mb.ship.restart", "restart", 0, 50);
        toggle("mb.ship.home", "home");
        toggle("mb.ship.all", "all");
        toggle("mb.ship.best", "best");
    }
}

/** what the map holds: everything that can be drilled (ores, sand, scrap) and the liquids of its floors, each with the tiles where it
 *  can be taken. Made once for a world (see loadRegistry), then kept. */
function shipSourceMap(){
    if(shipMap != null) return shipMap;
    var map = {items: [], liquids: [], itemTiles: {}, liquidTiles: {}};
    var seenI = {}, seenL = {};
    var w = Vars.world, W = w.width(), H = w.height();
    try{
        for(var x = 0; x < W; x++){
            for(var y = 0; y < H; y++){
                var t = w.tile(x, y);
                if(t == null) continue;
                var d = t.drop();
                // what lies inside a wall (the black zone) cannot be reached: a machine does not drill through the landscape
                var inWall = false;
                try{
                    var tb = t.block();
                    inWall = tb != null && tb.solid && tb.fillsTile && !tb.synthetic();
                }catch(e0){ inWall = false; }
                if(d != null && !inWall){        // sand, scrap and the like are in too: they are drilled just the same
                    if(seenI[d.id] === undefined){
                        seenI[d.id] = true;
                        map.items.push(d);
                        map.itemTiles[d.id] = [];
                    }
                    map.itemTiles[d.id].push(pk(x, y));
                }
                var f = t.floor();
                var l = f == null ? null : f.liquidDrop;
                if(l != null){
                    if(seenL[l.id] === undefined){
                        seenL[l.id] = true;
                        map.liquids.push(l);
                        map.liquidTiles[l.id] = [];
                    }
                    map.liquidTiles[l.id].push(pk(x, y));
                }
            }
        }
    }catch(e){
        logErr("ship source map", e);
    }
    map.items.sort((p, q) => p.id - q.id);
    map.liquids.sort((p, q) => p.id - q.id);
    shipMap = map;
    return map;
}

/** the nearest tile of the map where `res` can be taken, to the world point (wx, wy): [tx, ty], or null */
function nearestSource(res, wx, wy){
    var map = shipSourceMap();
    var list = isLiquidRes(res) ? map.liquidTiles[res.id] : map.itemTiles[res.id];
    if(list == null || list.length == 0) return null;
    var best = -1, bestD = 1e18, cx = wx / TS, cy = wy / TS;
    for(var i = 0; i < list.length; i++){
        var k = list[i];
        var dx = (k >> 16) - cx, dy = (k & 0xFFFF) - cy, dd = dx * dx + dy * dy;
        if(dd < bestD){ bestD = dd; best = k; }
    }
    return best < 0 ? null : [pkx(best), pky(best)];
}

/** does the map have `res` at all (cheap: no walk over the tiles) */
function shipHasSource(res){
    var map = shipSourceMap();
    var list = isLiquidRes(res) ? map.liquidTiles[res.id] : map.itemTiles[res.id];
    return list != null && list.length > 0;
}

/** how much of `res` the machine holds and how much its containers can hold together: items are counted in its storages
 *  (cores, containers), liquids in every block of it that has a tank */
function shipStock(m, res){
    var blds = m.mode == "fly" ? m.parts : membersOf(m.cells, m.team);
    var liq = isLiquidRes(res), have = 0, cap = 0;
    blds.forEach(b => {
        if(b.dead || isConstructing(b)) return;
        if(liq){
            if(b.liquids != null && b.block.liquidCapacity > 0){
                have += b.liquids.get(res);
                cap += b.block.liquidCapacity;
            }
        }else if(b.items != null && b.block instanceof StorageBlock){
            have += b.items.get(res);
            cap += b.getMaximumAccepted(res);
        }
    });
    return {have: have, cap: cap};
}

/** the part of a flying machine that takes `res` out of the ground under it: a drill tough enough for an item, any pump for a liquid */
function shipExtractor(m, res){
    var liq = isLiquidRes(res);
    for(var i = 0; i < m.parts.length; i++){
        var b = m.parts[i];
        if(b.dead || isConstructing(b)) continue;
        if(liq){
            if(isPumpBlock(b.block)) return b;
        }else if(b.block instanceof Drill && b.block.tier >= res.hardness){
            return b;
        }
    }
    return null;
}

/** The autopilot of a flying machine. For every ship control block set to a resource: a machine that holds none of it flies
 *  to the nearest place on the map where it can be taken (a vein for an ore, a water body for a liquid), stays over it with
 *  its drill / pump touching it, and goes on until it holds SHIP_HALF of its maximum. Only a machine with a drill (ore) or a
 *  pump (liquid) of its own goes. The autopilot does nothing while a player drives the machine or an RTS order is given. */
function shipTick(m, delta){
    if(m.mode != "fly") return;
    m.shipTimer = (m.shipTimer === undefined ? 0 : m.shipTimer) - delta;
    if(m.shipTimer > 0) return;
    m.shipTimer = SHIP_PERIOD;
    if(m.shipHome != null){ shipHomeTick(m); return; }
    // a control block in the supply mode takes the machine over: it carries from the core to the chosen store
    var supply = [];
    for(var si = 0; si < m.parts.length; si++){
        var sc = m.parts[si];
        if(!isShipControl(sc) || sc.dead) continue;
        var sres = shipCfg[sc.id], sopt = shipOptOf(sc);
        if(sres != null && sopt.supply) supply.push({c: sc, opt: sopt, res: sres});
    }
    if(supply.length > 0){ shipSupplyTick(m, supply); return; }
    m.shipSup = null;
    m.shipJobs = null;
    var old = m.shipLatch === undefined ? {} : m.shipLatch;
    var latch = {}, want = null, homeRes = null, homeOpt = null;
    for(var i = 0; i < m.parts.length; i++){
        var c = m.parts[i];
        if(!isShipControl(c) || c.dead) continue;
        var res = shipCfg[c.id];
        if(res == null) continue;
        var key = (isLiquidRes(res) ? "l" : "i") + res.id;
        if(latch[key] !== undefined) continue;
        var opt = shipOptOf(c);
        var was = old[key] === true, on = was;
        var st = shipStock(m, res);
        // any item that has filled its store (a drill over a mixed vein brings others too) stops the drills just the same
        var anyFull = !isLiquidRes(res) && opt.all && shipAnyFull(m, opt.full);
        if(on){
            if(st.cap <= 0 || st.have >= st.cap * opt.full || anyFull) on = false;
        }else if(st.cap > 0 && !anyFull && (st.have <= st.cap * opt.restart || (m.shipRestart === true && st.have < st.cap * opt.full)) &&
                 shipExtractor(m, res) != null && shipHasSource(res)){
            // (the drills drop what they hold into the containers the moment the machine is unloaded, so "empty" is not
            //  asked for: the next trip starts at once after an unload)
            on = true;
            m.shipRestart = false;
        }
        if(on != was) say(on ? "mb.msg.shipgo" : "mb.msg.shipdone", res.localizedName);
        latch[key] = on;
        if(on && want == null) want = {key: key, res: res, best: opt.best};
        // a load that has reached the set share (or an item that has filled its store) is carried home
        if(!on && homeRes == null && opt.home && st.cap > 0 && (st.have >= st.cap * opt.full || anyFull)){
            homeRes = res;
            homeOpt = opt;
        }
    }
    m.shipLatch = latch;
    if(homeRes != null && m.shipHome == null && !(Time.globalTime < (m.shipHomeWait === undefined ? 0 : m.shipHomeWait)) && shipHomeDest(m, homeRes, homeOpt) != null){
        m.shipHome = {res: homeRes, all: homeOpt.all, opt: homeOpt};
        m.shipGoal = null;
        say("mb.msg.shiphome", homeRes.localizedName);
        return;
    }
    if(want == null){
        m.shipGoal = null;
    }else if(m.shipGoal == null || m.shipGoal.key != want.key){
        m.shipGoal = shipPlanGoal(m, want.key, want.res, want.best);
    }
}

/** true when some item in the stores of the machine has reached `frac` of what a store holds of it */
function shipAnyFull(m, frac){
    var items = Vars.content.items();
    for(var i = 0; i < m.parts.length; i++){
        var b = m.parts[i];
        if(b.dead || b.items == null || !(b.block instanceof StorageBlock)) continue;
        for(var j = 0; j < items.size; j++){
            var it = items.get(j);
            var amt = b.items.get(it);
            if(amt > 0 && amt >= frac * b.getMaximumAccepted(it)) return true;
        }
    }
    return false;
}

/** the core the machine carries its load to: the nearest core of its team (null when there is none) */
function shipCore(m){
    try{
        var c = Vars.state.teams.closestCore(m.x, m.y, m.team);
        if(c != null) return c;
    }catch(e){ /* try the plain way */ }
    try{ return m.team.core(); }catch(e2){ return null; }
}

/** a free tank of the team that takes `res`: the nearest one to the machine (not a block of the machine itself), or null */
function shipTank(m, res){
    var own = {};
    m.parts.forEach(b => { own[b.id] = true; });
    var best = null, bd = 1e18;
    try{
        var arr = m.team.data().buildings;
        for(var i = 0; i < arr.size; i++){
            var b = arr.get(i);
            if(b == null || !b.isValid() || own[b.id] === true) continue;
            if(b.liquids == null || !b.block.hasLiquids || b.block.liquidCapacity < 300) continue;      // tanks, not conduits and pumps
            if(b.block.liquidCapacity - b.liquids.get(res) < 20) continue;                            // full
            if(!b.acceptLiquid(b, res)) continue;                                                      // holds another liquid
            var d = Mathf.dst(b.x, b.y, m.x, m.y);
            if(d < bd){ bd = d; best = b; }
        }
    }catch(e){ logErr("ship tank", e); best = null; }
    return best;
}

/** the building of the team on a chosen tile, if it can hold what is carried (items or a liquid), else null */
function shipTileBuilding(m, x, y, res){
    if(x === undefined || x < 0) return null;
    var t = Vars.world.tile(x, y);
    if(t == null || t.build == null || !t.build.isValid() || t.build.team != m.team) return null;
    var b = t.build;
    if(res != null && isLiquidRes(res)){
        if(b.liquids == null || !b.block.hasLiquids) return null;
    }else if(b.items == null || !b.block.hasItems){
        return null;
    }
    return b;
}

/** the store the player chose for a control block to unload into (a container, a vault, the core, a tank), or null */
function shipDestBuilding(m, opt, res){
    return opt == null ? null : shipTileBuilding(m, opt.dx, opt.dy, res);
}

/** the store a supplying machine loads from: the one the player chose (and no other); without a choice the core for items,
 *  and nothing for a liquid (a liquid has to come from a tank: it must be chosen) */
function shipSrcBuilding(m, opt, res){
    if(opt != null && opt.sx !== undefined && opt.sx >= 0) return shipTileBuilding(m, opt.sx, opt.sy, res);
    return isLiquidRes(res) ? null : shipCore(m);
}

/** where the load of the machine goes: the chosen store (and nowhere else: if it is gone the machine waits), otherwise the
 *  core for items (a machine with a core of its own IS home and goes nowhere) or a free tank for a liquid */
function shipHomeDest(m, res, opt){
    if(opt != null && opt.dx !== undefined && opt.dx >= 0) return shipDestBuilding(m, opt, res);
    if(isLiquidRes(res)) return shipTank(m, res);
    if(m.parts.some(b => !b.dead && b.block instanceof Packages.mindustry.world.blocks.storage.CoreBlock)) return null;
    return shipCore(m);
}

// ---------------------------------------------------------------------------
//  docking: ships that go to the same building (the core, a store, a tank) form ONE LINE in the order they come near.
//  The first one docks, the others wait on their own places around it (a place for every position of the line, so nobody
//  stands on another one), and every ship moves up when the one before it leaves. A ship stays in the line only while it
//  really aims at that building: a ship that waits for free space (hold), is idle, was taken over by a player or flies
//  somewhere else never blocks the others.
// ---------------------------------------------------------------------------
var shipQueues = {};                  // building pos -> machine ids, the first one docks
var SHIP_QUEUE_R = TS * 14;           // a ship joins the line when it is this close to the building
var SHIP_HEAD_MAX = 900;              // a ship that has been first for 15 s without finishing is sent to the end of the line

function machineById(id){
    for(var i = 0; i < machines.length; i++) if(machines[i].id === id) return machines[i];
    return null;
}

/** the ship stops aiming at its building (a new job, hold ...): leave the line at once */
function shipDockLeave(m){
    if(m.dockAt == null) return;
    var q = shipQueues[m.dockAt];
    if(q != null){
        var i = q.indexOf(m.id);
        if(i >= 0) q.splice(i, 1);
        if(q.length == 0) delete shipQueues[m.dockAt];
    }
    m.dockAt = null;
    m.dockHead = false;
}

/** drops the ships that no longer aim at this building (gone, landed, another job, nobody looked after them for 0.5 s) */
function shipQueuePrune(k, q){
    for(var i = q.length - 1; i >= 0; i--){
        var o = machineById(q[i]);
        if(o == null || o.mode != "fly" || o.dockAt !== k || Time.globalTime - (o.dockSeen || 0) > 30){
            if(o != null && o.dockAt === k){ o.dockAt = null; o.dockHead = false; }
            q.splice(i, 1);
        }
    }
}

var shipDockReq = {};                 // machine id -> {k, x, y, r, t, act, seen}: the ships that are first in a line and want the dock

/** Two docks that lie so close that the hulls of two machines would overlap cannot be used at the same time (the machines would push
 *  each other away from the docks and none would unload): the one that asked first has the dock, the other waits at its place in
 *  the line. A dock that has been held for 30 s without a result is not held any more. */
function shipDockAreaFree(m, build){
    var now = Time.globalTime;
    var mr = Math.max(m.radius || 12, 16);
    var rq = shipDockReq[m.id];
    if(rq == null || rq.k !== build.pos()) rq = shipDockReq[m.id] = {k: build.pos(), t: now, act: false};
    rq.x = build.x; rq.y = build.y; rq.r = mr; rq.seen = now;
    for(var id in shipDockReq){
        if(+id === m.id) continue;
        var o = shipDockReq[id];
        var om = machineById(+id);
        if(om == null || om.mode != "fly" || now - o.seen > 45){ delete shipDockReq[id]; continue; }
        if(Mathf.dst(rq.x, rq.y, o.x, o.y) >= (mr + o.r) * 0.8 + 16) continue;                   // far enough: both can dock
        var oHolds = o.act && now - (o.actSince || now) < 1800;
        var oFirst = o.t < rq.t || (o.t === rq.t && +id < m.id);
        if(oHolds || (!rq.act && oFirst)) return false;
    }
    if(!rq.act){ rq.act = true; rq.actSince = now; }
    return true;
}

/** the place of the ship in the line of the building: 0 docks, 1.. wait, -1: still too far to be in the line */
function shipDockJoin(m, build){
    var k = build.pos();
    if(m.dockAt != null && m.dockAt !== k) shipDockLeave(m);
    m.dockAt = k;
    m.dockSeen = Time.globalTime;
    var q = shipQueues[k];
    if(q == null) q = shipQueues[k] = [];
    shipQueuePrune(k, q);
    var i = q.indexOf(m.id);
    if(i < 0){
        // The waiting places lie up to three gaps from the dock (a gap is two hull radii and a bit): the ship joins the line when it is
        // inside them, so a BIG machine, whose waiting place is far out, also gets into the line (a fixed radius left it outside).
        var mrj = Math.max(m.radius || 12, 16);
        var r0j = Math.max(build.block.size * TS * 0.55, TS * 1.2) + mrj * 0.35;
        var joinR = Math.max(SHIP_QUEUE_R, r0j + (mrj * 2 + 24) * 3 + mrj);
        if(Mathf.dst(m.x, m.y, build.x, build.y) > joinR + build.block.size * TS / 2){
            m.dockHead = false;
            return -1;
        }
        q.push(m.id);
        i = q.length - 1;
        m.slotAng = Math.atan2(m.y - build.y, m.x - build.x);        // it waits on the side it came from
    }
    // the first ship has the dock for a limited time: if it cannot finish (stuck), the next one gets its turn
    if(i === 0 && q.length > 1){
        var hs = shipQueues["h" + k];
        if(hs == null || hs.id !== m.id) hs = shipQueues["h" + k] = {id: m.id, t: Time.globalTime};
        if(Time.globalTime - hs.t > SHIP_HEAD_MAX){
            q.push(q.shift());
            delete shipQueues["h" + k];
            i = q.indexOf(m.id);
        }
    }
    m.dockHead = i === 0;
    return i;
}

/** the place where the ship should stand: the dock for the first one, its own waiting place for the others */
function shipApproachPoint(m, build){
    if(build == null) return null;
    var i = shipDockJoin(m, build);
    var blocked = i === 0 && !shipDockAreaFree(m, build);                         // first, but the dock of another machine is too close
    if(blocked){ var qb = shipQueues[build.pos()]; i = (qb != null ? qb.length : 1) + 1; }
    var mr = Math.max(m.radius || 12, 16);
    var r0 = Math.max(build.block.size * TS * 0.55, TS * 1.2) + mr * 0.35;      // the dock: close to the building
    var ang = m.slotAng != null ? m.slotAng : Math.atan2(m.y - build.y, m.x - build.x);
    var r = r0, a = ang;
    if(i !== 0){
        // the waiting places: a fan on the side the ship came from, a new ring for every four ships
        var gap = mr * 2 + 24;
        var k = i < 0 ? 1 : i;
        var ring = Math.floor((k - 1) / 4), idx = (k - 1) % 4;
        var side = (idx % 2 == 0 ? 1 : -1) * Math.ceil((idx + 1) / 2);              // 1, -1, 2, -2
        r = r0 + gap * (1 + ring);
        a = ang + side * gap / r;
    }
    m.dockHead = i === 0;
    return {
        x: build.x + Math.cos(a) * r,
        y: build.y + Math.sin(a) * r,
        bx: build.x, by: build.y,
        stop: 0, target: null, lever: 0
    };
}

/** how much of `res` the building can still take (0 = full / refuses) */
function shipDestSpace(dest, res){
    if(dest == null || res == null) return 0;
    try{
        if(isLiquidRes(res)){
            if(dest.liquids == null || !dest.acceptLiquid(dest, res)) return 0;
            return Math.max(0, dest.block.liquidCapacity - dest.liquids.get(res));
        }
        if(dest.items == null) return 0;
        var n = dest.acceptStack(res, 999999, null);
        return n > 0 ? n : 0;
    }catch(e){ return 0; }
}

/** true when this ship is the first in the line of `build`: only then it may load / unload (the radius is checked by the caller) */
function shipMayDock(m, build, rad){
    if(build == null) return false;
    return shipDockJoin(m, build) === 0 && shipDockAreaFree(m, build);
}

/** a ship that waits for free space in the store: far out, on a place of its own (by its id), and not in the line */
function shipHoldPoint(m, build){
    if(build == null) return null;
    shipDockLeave(m);
    delete shipDockReq[m.id];
    var mr = Math.max(m.radius || 12, 16);
    var r0 = Math.max(build.block.size * TS * 0.55, TS * 1.2) + mr * 0.35;
    var gap = mr * 2 + 24;
    var a = (m.id * 2.399963) % (Math.PI * 2);                                      // the golden angle: ids spread evenly
    var r = r0 + gap * (2 + (m.id % 3) * 0.7);                  // behind the places of the line, but still close to the store
    return {x: build.x + Math.cos(a) * r, y: build.y + Math.sin(a) * r, bx: build.x, by: build.y, stop: 0, target: null, lever: 0};
}

/** soft push away from other flying machines (AI only) */
// ---------------------------------------------------------------------------
//  going round other machines: every machine that flies on its own looks ahead at every other flying machine (also the
//  ones that stand still and the ones that a player drives), works out where the two will be closest, and if that is nearer
//  than the two hulls (plus a margin) it turns aside in good time. The side is chosen by where the other one is, so two
//  machines that meet always turn to opposite sides: they pass each other and nothing has to be agreed upon. Near its own
//  goal a machine does not avoid (it goes there; the soft push below and the collisions take care of the rest).
// ---------------------------------------------------------------------------
var AVOID_HORIZON = 200;      // ticks that are looked ahead
var AVOID_MARGIN = 14;        // world units of room that are kept beyond the two radii

/** returns [sideways x, sideways y, speed factor]: add the first two to the wanted speed, multiply the wanted speed by the third */
function shipAvoid(m, tvx, tvy, spd, goalLeft){
    var speed = Math.sqrt(tvx * tvx + tvy * tvy);
    if(speed < 0.02 || m.arrived === true) return [0, 0, 1];
    var mr = m.radius || 12;
    var nearGoal = Mathf.clamp((goalLeft - 20) / (mr * 2), 0, 1);
    if(nearGoal <= 0) return [0, 0, 1];
    var fl = flyingMachines();
    var ax = 0, ay = 0, slow = 1;
    for(var i = 0; i < fl.length; i++){
        var o = fl[i];
        if(o === m || o.mode != "fly") continue;
        var rx = o.x - m.x, ry = o.y - m.y;
        var dist = Math.sqrt(rx * rx + ry * ry);
        if(dist < 1) continue;
        var R = mr + (o.radius || 12) + AVOID_MARGIN;
        if(dist > R + speed * AVOID_HORIZON) continue;                      // too far to matter within the time that is looked ahead
        var wx = tvx - (o.vx || 0), wy = tvy - (o.vy || 0);                 // my speed as the other one sees it
        var ww = wx * wx + wy * wy;
        var t = 0, dmin = dist;
        if(ww > 1e-6){
            t = (rx * wx + ry * wy) / ww;                                   // when we are closest
            if(t < 0) t = 0;                                                 // we move apart: only the present distance counts
            if(t > AVOID_HORIZON) continue;
            var cx = rx - wx * t, cy = ry - wy * t;
            dmin = Math.sqrt(cx * cx + cy * cy);
        }
        var Rs = R * 1.25;                                                   // turn a little before the safe distance, so that it is really kept
        if(dmin >= Rs) continue;
        var sv = Mathf.clamp((Rs - dmin) / (Rs * 0.7), 0, 1) * (0.4 + 0.6 * (1 - t / AVOID_HORIZON));
        var wl = Math.sqrt(ww), nx, ny;
        if(wl < 1e-3){ nx = -ry / dist; ny = rx / dist; }                    // no relative motion: sideways of the line between us
        else{ nx = wy / wl; ny = -wx / wl; }                                 // sideways of the relative motion
        var dir = (rx * nx + ry * ny) >= 0 ? -1 : 1;                         // go to the side that is away from the other machine
        ax += nx * dir * sv;
        ay += ny * dir * sv;
        var fwd = (rx * tvx + ry * tvy) / (dist * speed);
        if(fwd > 0.5 && dist < R * 1.6) slow = Math.min(slow, 1 - 0.5 * sv);   // right ahead and close: ease off a little
    }
    var al = Math.sqrt(ax * ax + ay * ay);
    if(al < 0.001) return [0, 0, slow];
    var power = Math.min(1, al) * spd * nearGoal;
    return [ax / al * power, ay / al * power, slow];
}

function shipSeparation(m, spd){
    if(m.dockHead === true) return [0, 0];            // the ship at the dock stays where it is
    var fl = flyingMachines();
    var sx = 0, sy = 0, n = 0;
    var want = Math.max((m.radius || 12) + 20, 40);
    for(var i = 0; i < fl.length; i++){
        var o = fl[i];
        if(o === m || o.mode != "fly") continue;
        var d = Mathf.dst(m.x, m.y, o.x, o.y);
        var minD = want + (o.radius || 12);
        if(d < 1 || d > minD) continue;
        var push = (minD - d) / minD;
        sx += (m.x - o.x) / d * push;
        sy += (m.y - o.y) / d * push;
        n++;
    }
    if(n == 0) return [0, 0];
    var len = Math.sqrt(sx * sx + sy * sy);
    if(len < 0.001) return [0, 0];
    var power = Math.min(1, len) * spd * 0.55;
    return [sx / len * power, sy / len * power];
}

/** flight goal of a machine that carries its load home: a free slot near the core / the store / the tank */
function shipHomeGoal(m){
    if(m.shipHome == null || m.mode != "fly") return null;
    var h = m.shipHome;
    var dest = shipHomeDest(m, h.res, h.opt);
    if(dest == null) return null;
    return shipApproachPoint(m, dest);
}

/** over the destination: the machine puts its load there, then the checks go on as usual: with an empty store it flies for
 *  the next load. Items go from its containers only (never from a drill or a turret). */
function shipHomeTick(m){
    var h = m.shipHome;
    if(m.parts.length == 0){ m.shipHome = null; return; }
    var dest = shipHomeDest(m, h.res, h.opt);
    if(dest == null){ m.shipHome = null; m.shipHomeWait = Time.globalTime + 600; return; }
    var dist = Mathf.dst(m.x, m.y, dest.x, dest.y);
    var homeR = Math.max(dest.block.size * TS * 0.85, TS * 2.2) + Math.max(m.radius || 12, 12) * 0.4;
    if(dist > homeR) return;      // still on the way
    if(!shipMayDock(m, dest, homeR * 1.4)) return;
    if(isLiquidRes(h.res)){
        shipPour(m, h, dest);
        return;
    }
    var moved = 0;
    try{
        var items = Vars.content.items();
        m.parts.forEach(b => {
            if(b.dead || b.items == null || !(b.block instanceof StorageBlock)) return;
            for(var j = 0; j < items.size; j++){
                var it = items.get(j);
                if(h.all !== true && it != h.res) continue;      // "unload everything" is on by default
                var amt = b.items.get(it);
                if(amt <= 0) continue;
                var n = dest.acceptStack(it, amt, null);
                if(n <= 0) continue;
                dest.handleStack(it, n, null);
                b.items.remove(it, n);
                moved += n;
            }
        });
    }catch(e){ logErr("ship unload", e); }
    m.shipHome = null;
    m.shipTimer = 0;
    if(moved > 0){
        m.shipRestart = true;
        if(h.all === true) say("mb.msg.shipunloadall", moved); else say("mb.msg.shipunload", h.res.localizedName, moved);
    }else{
        m.shipHomeWait = Time.globalTime + 600;                        // it cannot take it: do not turn back at once
        say("mb.msg.shipfull", h.res.localizedName);
    }
}

/** the liquid version of the unloading: pours the liquid of the machine into the tank */
function shipPour(m, h, tank){
    var res = h.res;
    var moved = 0;
    try{
        if(!tank.acceptLiquid(tank, res)){
            m.shipHome = null; m.shipHomeWait = Time.globalTime + 600; say("mb.msg.shipfull", res.localizedName); return;
        }
        var space = tank.block.liquidCapacity - tank.liquids.get(res);
        m.parts.forEach(b => {
            if(b.dead || space <= 0 || b.liquids == null || b.block.liquidCapacity <= 0 || b === tank) return;
            var amt = b.liquids.get(res);
            if(amt <= 0) return;
            var n = Math.min(amt, space);
            tank.liquids.add(res, n);
            b.liquids.remove(res, n);
            space -= n;
            moved += n;
        });
    }catch(e){ logErr("ship pour", e); }
    m.shipHome = null;
    m.shipTimer = 0;
    if(moved > 1){
        m.shipRestart = true;
        say("mb.msg.shipunloadliq", res.localizedName, Math.round(moved));
    }else{
        m.shipHomeWait = Time.globalTime + 600;
        say("mb.msg.shipfull", res.localizedName);
    }
}

/** every item and liquid of the game that can be carried (for the supply mode: the source may hold what is not on the map) */
function shipAllItems(){
    var out = [], items = Vars.content.items(), liqs = Vars.content.liquids();
    for(var i = 0; i < items.size; i++){
        var it = items.get(i);
        try{ if(it.isHidden()) continue; }catch(e){ /* no such flag */ }
        out.push(it);
    }
    for(var j = 0; j < liqs.size; j++){
        var lq = liqs.get(j);
        try{ if(lq.isHidden()) continue; }catch(e2){ /* no such flag */ }
        out.push(lq);
    }
    return out;
}

/** puts the item / liquid from the store `src` (the core, a container, a tank) into the containers / tanks of the machine, up to
 *  `frac` of what each holds; returns how much */
/** loads `res` from `src` into the containers / tanks of the machine, up to `frac` of their capacity and (if `limit` is given) up to
 *  `limit` units on board in all: a machine does not carry what the store cannot take */
function shipLoadFrom(m, src, res, frac, limit){
    var moved = 0;
    var budget = limit === undefined ? 1e18 : limit - shipStock(m, res).have;
    if(budget <= 0) return 0;
    if(isLiquidRes(res)){
        var haveL = src.liquids.get(res);
        m.parts.forEach(b => {
            if(haveL <= 0 || budget <= 0 || b.dead || b.liquids == null || b.id === src.id || b.block.liquidCapacity < 300) return;
            var room = b.block.liquidCapacity * frac - b.liquids.get(res);
            if(room <= 1 || !b.acceptLiquid(b, res)) return;
            var n = Math.min(room, haveL, budget);
            b.liquids.add(res, n);
            src.liquids.remove(res, n);
            haveL -= n;
            budget -= n;
            moved += n;
        });
        return moved;
    }
    var have = src.items.get(res);
    m.parts.forEach(b => {
        if(have <= 0 || budget <= 0 || b.dead || b.items == null || !(b.block instanceof StorageBlock)) return;
        if(b.block instanceof Packages.mindustry.world.blocks.storage.CoreBlock) return;
        var room = Math.floor(b.getMaximumAccepted(res) * frac) - b.items.get(res);
        if(room <= 0) return;
        var n = b.acceptStack(res, Math.min(room, have, Math.floor(budget)), null);
        if(n <= 0) return;
        b.handleStack(res, n, null);
        src.items.remove(res, n);
        have -= n;
        budget -= n;
        moved += n;
    });
    return moved;
}

/** pours the liquid of the machine into the tank `dest`; returns how much */
function shipGiveLiquid(m, res, dest){
    var moved = 0;
    if(!dest.acceptLiquid(dest, res)) return 0;
    var space = dest.block.liquidCapacity - dest.liquids.get(res);
    m.parts.forEach(b => {
        if(b.dead || space <= 0 || b.liquids == null || b.block.liquidCapacity <= 0 || b.id === dest.id) return;
        var amt = b.liquids.get(res);
        if(amt <= 0) return;
        var n = Math.min(amt, space);
        dest.liquids.add(res, n);
        b.liquids.remove(res, n);
        space -= n;
        moved += n;
    });
    return moved;
}

/** The supply mode: the machine takes the item / liquid from the source (the core by default for items, any container or
 *  tank that was chosen), carries it to the chosen store, unloads, and again. Two phases: "load" (at the source) and "give"
 *  (at the store). Any item of the game can be carried, not only what the map has. */
/** Every control block in the supply mode is a JOB of its own (a resource, a source, a store). A machine with several of them
 *  carries all the resources in one trip: at a building every job that belongs to it works in the same visit (at the core all the
 *  jobs load, at a store every job that has a cargo for it unloads), then the machine flies on to the next building. */
function shipSupplyTick(m, list){
    m.shipGoal = null;
    m.shipLatch = {};
    var jobs = m.shipJobs;
    if(jobs == null) jobs = m.shipJobs = {};
    var keep = {};
    var order = [];
    list.forEach(it => {
        var j = jobs[it.c.id];
        if(j == null || j.res != it.res) j = jobs[it.c.id] = {id: it.c.id, res: it.res, phase: "load", opt: it.opt, idle: true};
        j.opt = it.opt;
        keep[it.c.id] = true;
        order.push(j);
    });
    for(var k in jobs) if(!keep[k]) delete jobs[k];
    for(var i = 0; i < order.length; i++){
        try{ shipJobStep(m, order[i]); }catch(e){ logErr("ship job", e); }
    }
    m.shipSup = shipPickJob(m, order);
}

/** the job that decides where the machine flies now: first what is on board (deliver everything before the next trip), then
 *  what has to be loaded, then what waits for room in a store */
function shipPickJob(m, order){
    var now = Time.globalTime;
    var waiting = j => j.wait !== undefined && now < j.wait;
    var j;
    for(var i = 0; i < order.length; i++){ j = order[i]; if(!j.idle && j.phase === "give") return j; }
    for(var i2 = 0; i2 < order.length; i2++){ j = order[i2]; if(!j.idle && j.phase === "load" && !waiting(j)) return j; }
    for(var i3 = 0; i3 < order.length; i3++){ j = order[i3]; if(!j.idle && j.phase === "hold") return j; }
    return null;
}

/** the amount of a liquid that counts as "nothing": tanks that stand close pass the liquid to each other all the time and the
 *  pumps / conduits of the machine hold a little too, so a leftover of a few units must not count as a cargo that is still on board */
function shipEps(m, res){
    var cap = shipStock(m, res).cap;
    return Math.max(3, Math.min(25, cap * 0.005));
}

/** what the ships do now: one line per machine, one entry per job (the setting "ship status") */
function shipInfoText(){
    var out = [];
    flyingMachines().forEach(m => {
        if(m.shipJobs == null) return;
        var parts = [];
        for(var k in m.shipJobs){
            var j = m.shipJobs[k];
            var t = j.res.localizedName + ": " + (j.idle ? "no store" : j.phase);
            if(!j.idle && j.wait !== undefined && Time.globalTime < j.wait) t += " " + Math.ceil((j.wait - Time.globalTime) / 60) + "s";
            if(j.why !== undefined) t += " (" + j.why + ")";
            parts.push(t);
        }
        out.push("#" + m.id + "  " + parts.join("  |  "));
    });
    return out.length > 0 ? out.join("\n") : "no ships";
}

/** "Container 300/300": how full the store is with this resource */
function shipStoreText(dest, res){
    try{
        if(isLiquidRes(res)) return dest.block.localizedName + " " + Math.round(dest.liquids.get(res)) + "/" + Math.round(dest.block.liquidCapacity);
        return dest.block.localizedName + " " + dest.items.get(res) + "/" + dest.getMaximumAccepted(res);
    }catch(e){ return "?"; }
}

/** tells why a cargo cannot be unloaded: the tank holds ANOTHER liquid, or the store is full (which store, how full) */
function shipSayFull(st, dest, res){
    st.why = shipStoreText(dest, res);
    if(Time.globalTime - (st.fullMsg || 0) <= 300) return;
    st.fullMsg = Time.globalTime;
    try{
        if(isLiquidRes(res) && dest.liquids != null && !dest.acceptLiquid(dest, res)){
            var other = dest.liquids.current();
            say("mb.msg.shipother", res.localizedName, other != null ? other.localizedName : "?");
            st.why = "another liquid: " + (other != null ? other.localizedName : "?");
            return;
        }
        if(!(dest.block instanceof Packages.mindustry.world.blocks.storage.CoreBlock)){
            say("mb.msg.shipstorefull", res.localizedName, dest.block.localizedName, st.why);
            return;
        }
    }catch(e){ /* the plain message then */ }
    say("mb.msg.shipfull", res.localizedName);
}

/** Every tick (the checks of a ship come every SHIP_PERIOD ticks): a liquid is poured into the store as soon as it takes any. A tank
 *  with pipes is emptied by them all the time and is "full" only for a moment, so pouring only at the checks left most of the cargo
 *  on board. The conditions are those of the unloading of the job: the machine is at the store and first in its line. */
function shipFastTick(m){
    var jobs = m.shipJobs;
    if(jobs == null || m.mode != "fly") return;
    for(var k in jobs){
        var j = jobs[k];
        if(j.idle || j.phase !== "give" || !isLiquidRes(j.res)) continue;
        if(j.wait !== undefined && Time.globalTime < j.wait) continue;
        var dest = shipDestBuilding(m, j.opt, j.res);
        if(dest == null || dest.liquids == null) continue;
        var giveR = Math.max(dest.block.size * TS * 0.85, TS * 2.2) + Math.max(m.radius || 12, 12) * 0.4;
        if(Mathf.dst(m.x, m.y, dest.x, dest.y) > giveR) continue;
        if(!shipMayDock(m, dest, giveR * 1.4)) continue;
        var given = 0;
        try{ given = shipGiveLiquid(m, j.res, dest); }catch(e){ logErr("ship pour", e); }
        if(given > 0) j.lastGive = Time.globalTime;
    }
}

/** one job: load at its source, unload at its store (see shipSupplyTick) */
function shipJobStep(m, st){
    var res = st.res, opt = st.opt;
    var liq = isLiquidRes(res);
    var eps = liq ? shipEps(m, res) : 0;
    var dest = shipDestBuilding(m, opt, res);
    var src = shipSrcBuilding(m, opt, res);
    if(dest == null || src == null || dest.id === src.id){ st.idle = true; return; }   // a store is not chosen: the job rests
    st.idle = false;
    // wait only blocks transfer logic for load; hold ships must still fly to the hold point
    if(st.phase !== "hold" && st.wait !== undefined && Time.globalTime < st.wait) return;
    var left = () => shipStock(m, res).have;
    if(st.phase === "load"){
        var loadR = Math.max(src.block.size * TS * 0.85, TS * 2.2) + Math.max(m.radius || 12, 12) * 0.4;
        if(Mathf.dst(m.x, m.y, src.x, src.y) > loadR) return;
        if(!shipMayDock(m, src, loadR * 1.4)) return;   // wait your turn: another ship is unloading/loading
        var moved = 0;
        // only what the store can take: a ship does not haul a cargo that it cannot unload
        var room = shipDestSpace(dest, res);
        var onBoard = left();
        var minLoad = Math.max(liq ? 10 : 5, shipStock(m, res).cap * opt.full * 0.1);
        var fits;
        if(liq){
            // A tank with pipes is not a store of its own size: the pipes keep emptying it, and the machine unloads into it all the
            // time (shipFastTick). So the room that it has just now says nothing about how much can be delivered: all the tanks
            // of the machine are filled. Only a tank that does not take this liquid at all (another one is inside) stops the trip.
            var takes = true;
            try{ takes = dest.liquids != null && dest.acceptLiquid(dest, res); }catch(e0){ takes = true; }
            fits = takes;
        }else{
            fits = !(room < minLoad);
        }
        if(onBoard <= eps && !fits){
            st.wait = Time.globalTime + 180;                     // the store cannot take it yet: no trip for nothing, look again in 3 s
            shipSayFull(st, dest, res);
            return;
        }
        try{ moved = shipLoadFrom(m, src, res, opt.full, liq ? undefined : onBoard + room); }catch(e){ logErr("ship load", e); }
        if(left() <= eps){
            st.wait = Time.globalTime + 300;                     // nothing in the source: look again in five seconds
            say("mb.msg.shipnone", res.localizedName);
            return;
        }
        if(moved > 0) say("mb.msg.shipload", res.localizedName, Math.round(moved));
        st.phase = "give";
        st.why = undefined;
        st.lastGive = Time.globalTime;
    }else if(st.phase === "hold"){
        // cargo does not fit in the store: sit further out and free the dock for other resources
        st.noDock = true;
        if(st.wait !== undefined && Time.globalTime < st.wait) return;
        // space freed? try give again
        if(shipDestSpace(dest, res) > eps){
            st.phase = "give";
            st.noDock = false;
            st.wait = undefined;
            st.why = undefined;
            st.lastGive = Time.globalTime;
        }else{
            st.why = shipStoreText(dest, res);
            st.wait = Time.globalTime + 180;   // recheck every 3 s
        }
    }else{
        // phase "give"
        st.noDock = false;
        // store already full for this resource: do not enter the dock
        if(shipDestSpace(dest, res) <= eps){
            if(liq){
                // A tank with pipes is full at one moment and takes more at the next (and the fast pour of every tick has just filled
                // it): a liquid does not wait elsewhere for room. The machine goes to the dock, stays there and pours as the pipes make
                // room; it gives up only after 20 s in which nothing went in.
                if(left() <= eps){ st.phase = "load"; st.noDock = false; return; }        // all of it went in
                if(st.lastGive === undefined) st.lastGive = Time.globalTime;
                if(Time.globalTime - st.lastGive < 1200){
                    st.why = shipStoreText(dest, res);
                    try{ if(!dest.acceptLiquid(dest, res)) shipSayFull(st, dest, res); }catch(e0){ /* no message then */ }
                    return;
                }
            }
            st.phase = "hold";
            st.noDock = true;
            st.wait = Time.globalTime + 180;
            shipSayFull(st, dest, res);
            return;
        }
        var giveR = Math.max(dest.block.size * TS * 0.85, TS * 2.2) + Math.max(m.radius || 12, 12) * 0.4;
        if(Mathf.dst(m.x, m.y, dest.x, dest.y) > giveR) return;
        if(!shipMayDock(m, dest, giveR * 1.4)) return;
        var given = 0;
        try{
            if(liq){
                given = shipGiveLiquid(m, res, dest);
            }else{
                m.parts.forEach(b => {
                    if(b.dead || b.items == null || !(b.block instanceof StorageBlock) || b.id === dest.id) return;
                    var amt = b.items.get(res);
                    if(amt <= 0) return;
                    var n = dest.acceptStack(res, amt, null);
                    if(n <= 0) return;
                    dest.handleStack(res, n, null);
                    b.items.remove(res, n);
                    given += n;
                });
            }
        }catch(e2){ logErr("ship give", e2); }
        if(given > eps){
            st.lastGive = Time.globalTime;
            say("mb.msg.shipunload", res.localizedName, Math.round(given));
        }
        if(left() > eps){
            if(liq && Time.globalTime - (st.lastGive !== undefined ? st.lastGive : Time.globalTime) < 1200){
                // A liquid: the pipes of the store keep emptying its tank, so it is full at one moment and takes more at the next.
                // The machine stays at the dock and keeps pouring (every tick, see shipFastTick); only after 20 s in which nothing
                // went in at all does it give up and wait for room somewhere else.
                st.why = shipStoreText(dest, res);
            }else if(given > eps && shipDestSpace(dest, res) > eps){
                // the store still takes it (the tanks of the machine passed some liquid on): go on at the next check, stay at the dock
            }else{
                // the store is full: leave the dock and wait for room
                st.phase = "hold";
                st.noDock = true;
                st.wait = Time.globalTime + 180;
                if(given <= eps) shipSayFull(st, dest, res);
            }
        }else{
            st.phase = "load";
            st.noDock = false;
        }
    }
}

function shipSupplyGoal(m){
    var st = m.shipSup;
    if(st == null || st.idle || m.mode != "fly") return null;
    var t = st.phase === "load" ? shipSrcBuilding(m, st.opt, st.res) : shipDestBuilding(m, st.opt, st.res);
    if(t == null) return null;
    if(st.phase === "hold") return shipHoldPoint(m, t);
    return shipApproachPoint(m, t);
}

/** every part of a flying machine that takes `res` out of the ground: the drills tough enough for an item, the pumps for a liquid */
function shipExtractors(m, res){
    var liq = isLiquidRes(res), out = [];
    for(var i = 0; i < m.parts.length; i++){
        var b = m.parts[i];
        if(b.dead || isConstructing(b)) continue;
        if(liq){
            if(isPumpBlock(b.block)) out.push(b);
        }else if(b.block instanceof Drill && b.block.tier >= res.hardness){
            out.push(b);
        }
    }
    return out;
}

/** the deposits of `res`: lumps of its tiles, linked through gaps of at most two tiles (made once for a world, then kept) */
function shipClusters(res){
    var map = shipSourceMap();
    if(map.clusters === undefined) map.clusters = {};
    if(map.clusters[res.id] !== undefined) return map.clusters[res.id];
    var list = isLiquidRes(res) ? map.liquidTiles[res.id] : map.itemTiles[res.id];
    var out = [];
    if(list != null && list.length > 0){
        if(list.length > SHIP_HUGE){
            // a field that covers the map (sand on a desert map): one lump, no sorting out of deposits (that would be a walk
            // over every tile and its neighbours, and a long freeze)
            out.push({tiles: list});
        }else{
            // a deposit: the tiles that are linked through gaps of at most two tiles
            var all = {}, seen = {};
            for(var i = 0; i < list.length; i++) all[list[i]] = true;
            for(var k = 0; k < list.length; k++){
                if(seen[list[k]] === true) continue;
                var queue = [list[k]], head = 0;
                seen[list[k]] = true;
                while(head < queue.length){
                    var t = queue[head++];
                    var tx = t >> 16, ty = t & 0xFFFF;
                    for(var dx = -2; dx <= 2; dx++){
                        for(var dy = -2; dy <= 2; dy++){
                            var nk = pk(tx + dx, ty + dy);
                            if(all[nk] === true && seen[nk] !== true){
                                seen[nk] = true;
                                queue.push(nk);
                            }
                        }
                    }
                }
                out.push({tiles: queue});
            }
        }
    }
    map.clusters[res.id] = out;
    return out;
}

/** The richest place: where to put the machine, and at which angle, so that its drills / pumps cover as many tiles of the
 *  ore as possible together. A deposit is a lump of ore tiles; the few deposits that promise most (size, a little less for a
 *  long way) are all planned, and the best plan wins. Inside a deposit the places tried are the ore tiles within
 *  SHIP_REGION tiles of the one nearest to the machine (a sample), with each of the first drills on it, at the four angles
 *  a quarter turn apart. A place is worth the number of ore tiles under all the drills together.
 *  Returns {mx, my, ang, score, tx, ty} (mx, my: the machine point in world units) or null. */
function shipPlan(m, res){
    var exts = shipExtractors(m, res);
    if(exts.length == 0) return null;
    var clusters = shipClusters(res);
    if(clusters.length == 0) return null;
    var w0 = extractorOffset(m, exts[0]);
    var ex = m.x + w0[0], ey = m.y + w0[1];
    // rank the deposits: the nearest tile of each, and size / distance
    var ranked = [];
    for(var ci = 0; ci < clusters.length; ci++){
        var tiles = clusters[ci].tiles, nearest = tiles[0], nd = 1e18;
        for(var ti = 0; ti < tiles.length; ti++){
            var dx = (tiles[ti] >> 16) * TS - ex, dy = (tiles[ti] & 0xFFFF) * TS - ey, dd = dx * dx + dy * dy;
            if(dd < nd){ nd = dd; nearest = tiles[ti]; }
        }
        var distTiles = Math.sqrt(nd) / TS;
        ranked.push({tiles: tiles, seed: [pkx(nearest), pky(nearest)], rank: Math.min(tiles.length, 600) * 200 / (200 + distTiles)});
    }
    ranked.sort((p, q) => q.rank - p.rank);
    var locals = exts.map(b => ({
        lx: b.tile.drawx() - m.ref[0] * TS,
        ly: b.tile.drawy() - m.ref[1] * TS,
        s: b.block.size
    }));
    var angles = [m.ang, m.ang + 90, m.ang + 180, m.ang + 270];
    var anchors = Math.min(3, locals.length);
    var maxX = (Vars.world.width() - 1) * TS, maxY = (Vars.world.height() - 1) * TS;
    var best = null;
    for(var ri = 0; ri < Math.min(5, ranked.length); ri++){
        var cl = ranked[ri];
        var set = {}, region = [];
        var R = SHIP_REGION, R2 = R * R, W2 = (R + 6) * (R + 6);
        for(var i = 0; i < cl.tiles.length; i++){
            var qx = (cl.tiles[i] >> 16) - cl.seed[0], qy = (cl.tiles[i] & 0xFFFF) - cl.seed[1], qd = qx * qx + qy * qy;
            if(qd <= W2){
                set[cl.tiles[i]] = true;
                if(qd <= R2) region.push(cl.tiles[i]);
            }
        }
        var step = Math.max(1, Math.ceil(region.length / 150));
        var score = (px, py, c, sn) => {
            var total = 0;
            for(var li = 0; li < locals.length; li++){
                var L = locals[li];
                var wx = px + L.lx * c - L.ly * sn, wy = py + L.lx * sn + L.ly * c;
                var tx = (L.s % 2 == 0) ? Math.round(wx / TS - 0.5) : Math.round(wx / TS);
                var ty = (L.s % 2 == 0) ? Math.round(wy / TS - 0.5) : Math.round(wy / TS);
                var lo = Math.floor((L.s - 1) / 2), hi = Math.floor(L.s / 2);
                for(var ax = tx - lo; ax <= tx + hi; ax++){
                    for(var ay = ty - lo; ay <= ty + hi; ay++){
                        if(set[pk(ax, ay)] === true) total++;
                    }
                }
            }
            return total;
        };
        for(var pi = 0; pi < region.length; pi += step){
            var tx0 = pkx(region[pi]) * TS, ty0 = pky(region[pi]) * TS;
            for(var ai = 0; ai < angles.length; ai++){
                var c = Mathf.cosDeg(angles[ai]), sn = Mathf.sinDeg(angles[ai]);
                for(var a = 0; a < anchors; a++){
                    var L2 = locals[a];
                    var px = tx0 - (L2.lx * c - L2.ly * sn), py = ty0 - (L2.lx * sn + L2.ly * c);
                    if(px < 0 || py < 0 || px > maxX || py > maxY) continue;
                    var sc = score(px, py, c, sn);
                    if(sc <= 0) continue;
                    var dist = Mathf.dst(px, py, m.x, m.y);
                    var value = sc * 200 / (200 + dist / TS);          // a long way costs a little
                    if(best == null || value > best.value){
                        best = {mx: px, my: py, ang: angles[ai], score: sc, value: value, tx: cl.seed[0], ty: cl.seed[1]};
                    }
                }
            }
        }
    }
    return best;
}

/** the goal of a trip for `res`: the richest place (see shipPlan); when no place is found, the old simple one, the vein
 *  nearest to the first drill / pump */
function shipPlanGoal(m, key, res, best){
    var plan = null;
    if(best !== false){
        try{ plan = shipPlan(m, res); }catch(e){ logErr("ship plan", e); }
    }
    if(plan != null){
        Log.info("[mb] ship: " + res.localizedName + " spot found, " + plan.score + " ore tiles under the drills");
        return {key: key, res: res, best: best !== false, tx: plan.tx, ty: plan.ty, mx: plan.mx, my: plan.my, ang: plan.ang};
    }
    var tile = shipNearestTile(m, res);
    return tile == null ? null : {key: key, res: res, best: best !== false, tx: tile[0], ty: tile[1]};
}

/** the vein nearest to the DRILL / PUMP that takes `res` (not to the middle of the machine: the drill may sit far from it):
 *  [tx, ty], or null */
function shipNearestTile(m, res){
    var px = m.x, py = m.y;
    var ext = shipExtractor(m, res);
    if(ext != null){
        var wp = extractorOffset(m, ext);
        px = m.x + wp[0];
        py = m.y + wp[1];
    }
    return nearestSource(res, px, py);
}

/** The distances to the veins are measured again from where the machine is NOW: the goal of the autopilot becomes the vein
 *  that is nearest at this moment. The goal used to be chosen once (when the trip began) and kept, so a machine that was sent
 *  elsewhere by a command still flew back to the old vein, even when another one was now much closer.
 *  Called after every carried out command (see shipWatchCommands, processOrders). */
function shipRefresh(m){
    if(m.mode != "fly") return;
    try{
        m.shipTimer = 0;                      // the stock of the machine is checked again at once, too
        var g = m.shipGoal;
        if(g == null) return;                 // no trip under way: the next check chooses the vein itself
        m.shipGoal = shipPlanGoal(m, g.key, g.res, g.best);
    }catch(e){
        logErr("ship refresh", e);
    }
}

/** Tells when a command of the machine has been carried out, and then measures the distances to the veins again (shipRefresh):
 *   - an RTS order (go there / attack / the last point of a queue) that was there a moment ago is gone: it was carried out;
 *   - a player has stopped driving the machine (the ride was a command of its own). */
function shipWatchCommands(m, possessed, hasOrder){
    var done = (m.hadOrder === true && !hasOrder && !possessed) || (m.wasPossessed === true && !possessed);
    m.hadOrder = hasOrder;
    m.wasPossessed = possessed;
    if(done) shipRefresh(m);
}

/** where a block of a flying machine lies relative to the machine point (m.x, m.y), in world units, at the current angle */
function extractorOffset(m, b){
    var lx = b.tile.drawx() - m.ref[0] * TS, ly = b.tile.drawy() - m.ref[1] * TS;   // in the frame of the machine
    var c = Mathf.cosDeg(m.ang), s = Mathf.sinDeg(m.ang);
    return [lx * c - ly * s, lx * s + ly * c, Math.sqrt(lx * lx + ly * ly)];
}

/** the flight goal of the autopilot: the machine is put where its extractor lies on the target tile (null = no goal).
 *  `lever` = how far the extractor is from the machine point: the goal moves by that much when the machine turns. */
function shipGoal(m){
    var g = m.shipGoal;
    if(g == null || m.mode != "fly") return null;
    if(g.mx !== undefined) return {x: g.mx, y: g.my, stop: 0, target: null, lever: 0};   // the planned place: a fixed point
    var ext = shipExtractor(m, g.res);
    if(ext == null) return null;
    var off = extractorOffset(m, ext);
    return {x: g.tx * TS - off[0], y: g.ty * TS - off[1], stop: 0, target: null, lever: off[2]};
}

// ---------------------------------------------------------------------------
//  orders of the RTS command panel: "land" and "take off" (a machine body gets them like any unit gets its commands)
// ---------------------------------------------------------------------------
var landCmd = null, takeoffCmd = null;
try{
    // no controller of their own: processOrders carries the order out, and the body keeps its own CommandAI (a controller
    // here would take over the body, and the RTS targets of the machine would never be finished)
    landCmd = new UnitCommand("mb-land", MOD + "-cmd-land", null);
    takeoffCmd = new UnitCommand("mb-takeoff", MOD + "-cmd-takeoff", null);
}catch(e){
    Log.err("[mb] land / take off commands not created: " + e);
}

/** the CommandAI of a body: Unit.command() returns it (not the UnitCommand), and the order is read and set on it */
function bodyAI(d){
    try{ return d != null && d.isValid() && d.isCommandable() ? d.command() : null; }catch(e){ return null; }
}

function setUnitCommand(d, cmd){
    var ai = bodyAI(d);
    if(ai == null) return;
    try{
        try{ ai.command(cmd); return; }catch(e0){ /* in this game version "command" is a field of CommandAI too, and Rhino reads the field instead of the method: call the method by reflection */ }
        var ms = ai.getClass().getMethods();
        for(var i = 0; i < ms.length; i++){
            if(String(ms[i].getName()) == "command" && ms[i].getParameterCount() == 1){
                ms[i].invoke(ai, cmd);
                return;
            }
        }
        ai.command = cmd;       // no such method at all: the field is the order
    }catch(e){ logErr("set command", e); }
}

var cmdIconsDone = false;
/** the panel draws an order with Icon.icons[its icon name]; our pictures are put there once, at the first frame of a game */
function registerCommandIcons(){
    if(cmdIconsDone) return;
    cmdIconsDone = true;
    try{
        [landCmd, takeoffCmd].forEach(c => {
            if(c == null) return;
            Icon.icons.put(c.icon, new Packages.arc.scene.style.TextureRegionDrawable(Core.atlas.find(c.icon)));
            var name = c.localized();
            if(name.indexOf("???") >= 0) Log.warn("[mb] no name in the bundle for the order " + c.name + " (got " + name + ")");
        });
    }catch(e){ logErr("command icons", e); }
}

/** the orders of the command panel. A landed machine keeps its body so that it can be picked for take off; "land" and
 *  "take off" are done once, then the body is back to the move order. */
/** while a machine is driven (not in the build mode) its body must not build: no plans, no block in the hand, no build speed */
function enforceNoBuild(){
    var driving = poss != null || anyRemote();
    var block = driving && !anyBuild();
    try{ driverType.buildSpeed = block ? 0 : 1; }catch(e){ /* cosmetic */ }
    if(!driving) return;
    for(var rk in remotes){
        try{
            if(bmRemote[remotes[rk].pl.id] === true) continue;       // this player is in his build mode: he may build
            var ru = remotes[rk].pl.unit();
            if(ru != null){ ru.clearBuilding(); ru.updateBuilding = false; }
        }catch(er){ /* nothing to clear */ }
    }
    if(poss == null || buildMode) return;
    try{
        var u = Vars.player == null ? null : Vars.player.unit();
        if(u != null){
            try{ u.clearBuilding(); }catch(e1){ /* no builder */ }
            try{ u.updateBuilding = false; }catch(e2){ /* no such field */ }
        }
        var inp = Vars.control.input;
        if(inp.block != null) inp.block = null;
        try{ if(inp.selectPlans.size > 0) inp.selectPlans.clear(); }catch(e3){ /* nothing hangs on the cursor */ }
    }catch(e4){ logErr("enforceNoBuild", e4); }
}

var bodyRepair = 0, bodyRepairRounds = 0;
/** after a world has been loaded: every machine must have a living body that can take orders; the stale selection of the
 *  RTS mode is dropped */
function repairBodies(){
    for(var i = 0; i < machines.length; i++){
        var m = machines[i];
        if(isDriven(m)) continue;
        var d = m.body;
        var ok = false;
        try{ ok = d != null && d.isValid() && d.isCommandable(); }catch(e){ ok = false; }
        if(ok) continue;
        Log.info("[mb] repairing the body of a " + m.mode + " machine");
        try{ if(d != null && d.isValid()) d.remove(); }catch(e1){ logErr("repair remove", e1); }
        m.body = null;
        ensureBody(m);
        if(m.mode == "fly") keepBody(m);
    }
    try{
        var sel = Vars.control.input.selectedUnits;
        if(sel != null && sel.size > 0) sel.removeAll(boolf(u => !u.isValid()));
    }catch(e2){ /* no selection to clean */ }
}

var phantomTimer = 0;
/** removes what should not exist: body units that no machine owns (they stay selectable in the command panel but there is no
 *  machine behind them), and landed machines that have no block left */
function sweepPhantoms(){
    if(busy) return;
    phantomTimer -= Time.delta;
    if(phantomTimer > 0) return;
    phantomTimer = 120;
    var known = {};
    for(var i = 0; i < machines.length; i++){
        var b = machines[i].body;
        try{ if(b != null && b.isValid()) known[b.id] = true; }catch(e){ /* stale body */ }
    }
    var orphans = [];
    Groups.unit.each(u => u.type == driverType, u => { if(!known[u.id]) orphans.push(u); });
    for(var oi = 0; oi < orphans.length; oi++){
        var u = orphans[oi];
        try{
            if(Vars.player != null && Vars.player.unit() == u) continue;
            if(u.isPlayer()) continue;                    // a body some player drives
            u.remove();
            Log.info("[mb] removed a body without a machine: " + u.id);
        }catch(e){ logErr("sweep orphan", e); }
    }
    for(var fi = machines.length - 1; fi >= 0; fi--){
        var fm = machines[fi];
        if(fm.mode != "fly") continue;
        if(fm.parts != null && fm.parts.length > 0){ fm.emptyFly = false; continue; }
        if(!fm.emptyFly){ fm.emptyFly = true; continue; }
        Log.info("[mb] dropped a flying machine without blocks");
        try{ destroyMachine(fm); }catch(e3){ logErr("sweep empty fly", e3); }
    }
    for(var mi = machines.length - 1; mi >= 0; mi--){
        var m = machines[mi];
        if(m.mode != "land") continue;
        var n = -1;
        try{ n = membersOf(m.cells, m.team).length; }catch(e){ n = -1; }
        if(n != 0){ m.emptySeen = false; continue; }
        if(!m.emptySeen){ m.emptySeen = true; continue; }       // empty twice in a row: it is really gone
        Log.info("[mb] dropped a landed machine without blocks");
        dropMachine(m);
    }
}

function processOrders(){
    registerCommandIcons();
    if(bodyRepair > 0){
        bodyRepair -= Time.delta;
        if(bodyRepair <= 0){
            try{ repairBodies(); }catch(e){ logErr("repairBodies", e); }
            bodyRepairRounds++;
            if(bodyRepairRounds < 3) bodyRepair = 150;
        }
    }
    try{ sweepPhantoms(); }catch(e){ logErr("sweepPhantoms", e); }
    for(var i = 0; i < machines.length; i++){
        var m = machines[i];
        if(m.mode == "land") ensureBody(m);
        var d = m.body;
        if(d == null || !d.isValid() || isDriven(m)) continue;
        var ai = bodyAI(d);
        if(ai == null) continue;
        var cmd = ai.currentCommand();          // the order the panel gave last (the move order when there is none)
        if(cmd == null || cmd === UnitCommand.moveCommand) continue;
        if(landCmd != null && cmd === landCmd){
            setUnitCommand(d, UnitCommand.moveCommand);
            // parks the machine: it stands on the grid WITHOUT the global build mode (G), and it is never glued to its neighbours
            if(m.mode == "fly") landMachine(m, true);
        }else if(takeoffCmd != null && cmd === takeoffCmd){
            setUnitCommand(d, UnitCommand.moveCommand);
            if(m.mode == "land"){
                takeOff(m);
                shipRefresh(m);               // the command is carried out: the distances to the veins are measured again
            }
        }
    }
}

var driverType = extend(UnitType, "driver", {
    draw(unit){ /* invisible: the machine itself is the visible thing */ }
});
driverType.constructor = prov(() => UnitEntity.create());
driverType.flying = true;
driverType.speed = 0;
driverType.accel = 0;
driverType.health = 1000000;
driverType.hitSize = 8;
driverType.hidden = true;
driverType.internal = false;
driverType.targetable = true;     // enemies aim at the machine ...
driverType.hittable = false;      // ... but bullets are handled per block by the mod
driverType.physics = false;
driverType.isEnemy = false;
driverType.useUnitCap = false;
driverType.allowedInPayloads = false;
driverType.bounded = false;
driverType.createWreck = false;
driverType.createScorch = false;
driverType.drawCell = false;
driverType.drawBody = false;
driverType.drawItems = false;
driverType.drawShields = false;
driverType.drawSoftShadow = false;
driverType.drawMinimap = false;
try{ driverType.engineSize = 0; }catch(e){}
try{ driverType.engineOffset = 0; }catch(e){}
try{ driverType.shadowElevation = 0; }catch(e){}
try{ driverType.shadowElevationScl = 0; }catch(e){}
try{ driverType.lightRadius = 0; }catch(e){}
driverType.hoverable = false;
driverType.logicControllable = false;
driverType.canAttack = false;
driverType.itemCapacity = 0;
driverType.buildSpeed = 1;
driverType.envDisabled = 0;
// RTS command mode: a machine understands "go there / attack that" (see commandGoal), and "land" / "take off" (see
// processOrders). The other orders of the panel (rebuild, assist, mine ...) mean nothing to it, so they are not offered.
try{
    var driverCommands = new Seq();
    driverCommands.add(UnitCommand.moveCommand);
    if(landCmd != null) driverCommands.add(landCmd);
    if(takeoffCmd != null) driverCommands.add(takeoffCmd);
    driverType.commands = driverCommands;
}catch(e){
    Log.err("[mb] driver commands not restricted: " + e);
}

// ---------------------------------------------------------------------------
//  geometry helpers (work for real tiles and pocket tiles alike)
// ---------------------------------------------------------------------------
function isHull(b){
    return b != null && (b.block instanceof StorageBlock);
}

function isConstructing(b){
    return (b.block instanceof ConstructBlock);
}

function isTurret(b){
    return b.block instanceof Turret;
}

var TractorClass = null;
try{ TractorClass = Packages.mindustry.world.blocks.defense.turrets.TractorBeamTurret; }catch(e){ TractorClass = null; }
/** Parallax and the like: a BaseTurret that is not a Turret (own aim, own beam, target kept in real world coordinates) */
function isTractor(b){
    return TractorClass != null && b != null && b.block instanceof TractorClass;
}

var NuclearClass = null;
try{ NuclearClass = Packages.mindustry.world.blocks.power.NuclearReactor; }catch(e){ NuclearClass = null; }
function isNuclear(b){ return NuclearClass != null && b != null && b.block instanceof NuclearClass; }

var reactorRule = {};      // part id -> was the reactor explosion enabled when the reactor was updated

/** A thorium reactor of a flying machine is updated with the explosion rules switched off: it kills itself inside its own update
 *  (heat >= 1) while the machine lives in the "pocket" world, so the game's explosion hit the real ground under the machine and
 *  nothing of the machine. Its own explosion is made by reactorBoom, against the machine. */
function updateReactor(p){
    var r = Vars.state.rules, re = r.reactorExplosions, de = r.damageExplosions;
    reactorRule[p.id] = re;
    r.reactorExplosions = false;
    r.damageExplosions = false;
    try{
        p.update();
    }finally{
        r.reactorExplosions = re;
        r.damageExplosions = de;
    }
}

/** the explosion of a reactor that died in flight: effects, and damage to every flying machine around (this one included) */
function reactorBoom(b){
    var blk = b.block, wx = b.x, wy = b.y;
    var enabled = reactorRule[b.id] !== false;
    delete reactorRule[b.id];
    if(!enabled) return;
    var radius = numOr(blk.explosionRadius, 19) * TS, dmg = numOr(blk.explosionDamage, 5000);
    // visual / audio: prefer block fields, else thorium reactor, else generic large explosion
    try{
        if(blk.explodeEffect != null) blk.explodeEffect.at(wx, wy);
        else if(Blocks.thoriumReactor != null && Blocks.thoriumReactor.explodeEffect != null) Blocks.thoriumReactor.explodeEffect.at(wx, wy);
        else Fx.reactorExplosion.at(wx, wy);
    }catch(e){
        try{ Fx.massiveExplosion.at(wx, wy); }catch(e2){ /* only the picture */ }
    }
    try{
        if(blk.explodeSound != null) blk.explodeSound.at(wx, wy);
        else if(Blocks.thoriumReactor != null && Blocks.thoriumReactor.explodeSound != null) Blocks.thoriumReactor.explodeSound.at(wx, wy);
        else Sounds.explosionbig.at(wx, wy);
    }catch(e){ /* only the sound */ }
    try{ Effect.shake(numOr(blk.explosionShake, 6), numOr(blk.explosionShakeDuration, 16), wx, wy); }catch(e){ /* only the shake */ }
    try{ netFx("boom", wx, wy, 0); }catch(eN){ /* the clients miss the picture */ }
    flyingMachines().forEach(o => {
        if(machines.indexOf(o) >= 0) splashParts(o, wx, wy, radius, dmg, null);
    });
    // the ground below: what stands and walks under the reactor is blown up too, as the game's reactor does (the damage is
    // four times the number of the block, like there). Flying things are left out here: the machines were hit above.
    try{
        Packages.mindustry.entities.Damage.damage(null, wx, wy, radius, dmg * 4, false, false, true);
    }catch(e){
        try{ Packages.mindustry.entities.Damage.damage(wx, wy, radius, dmg * 4); }catch(e2){ logErr("reactor ground damage", e2); }
    }
}

/** blocks of a flying machine that killed themselves (kill() inside their own update): they are taken out of the machine */
function reapDead(m){
    var gone = false, booms = [];
    for(var i = m.parts.length - 1; i >= 0; i--){
        var b = m.parts[i];
        if(!b.dead) continue;
        if(isNuclear(b) || isReactorBooster(b)) booms.push(b);
        try{ withPocket(m, () => { b.tile.setBlock(Blocks.air); }, true); }catch(e){ logErr("reap", e); }
        m.parts.splice(i, 1);
        delete partIndex[b.id];
        delete bstates[b.id];
        if(m.hull === b) m.hull = null;
        gone = true;
    }
    for(var bi = 0; bi < booms.length; bi++){
        try{ reactorBoom(booms[bi]); }catch(e){ logErr("reactorBoom", e); }
    }
    if(gone && machines.indexOf(m) >= 0) flyReconcile(m);
    return gone;
}

function isBooster(b){
    return b != null && (b.block === rocketBooster || b.block === energyBooster || b.block === fuelBooster || b.block === reactorBooster);
}
function isReactorBooster(b){
    return b != null && b.block === reactorBooster;
}

/** thrust of one booster right now, in rocket booster units (what it would give if the machine is driven) */
function boosterThrust(b){
    var blk = b.block;
    if(blk === rocketBooster) return 1;
    if(blk === energyBooster) return ENERGY_THRUST * Mathf.clamp(b.power.status) * liquidMult(b);
    if(blk === fuelBooster){
        var s = bstate(b);
        var base;
        if(s.burn > 0 && s.item != null) base = fuelMult(s.item);
        else{
            var nf = nextFuel(b);
            base = nf == null ? 0 : fuelMult(nf);
        }
        return base * liquidMult(b);
    }
    if(blk === reactorBooster){
        // works with or without cryo; without cryo it still pushes but overheats toward a boom
        var s = bstate(b);
        var hasFuel = (s.burn > 0) || (b.items != null && b.items.get(Items.thorium) > 0);
        return hasFuel ? REACTOR_THRUST : 0;
    }
    return 0;
}

/** tiles/s the flying machine can reach right now: total thrust x power of one booster / tiles of the machine */
function flightSpeed(m){
    var cells = m.stats == null ? 0 : m.stats.cells;
    if(cells <= 0) return 0;
    var th = 0, list = m.boosters;
    for(var i = 0; i < list.length; i++){
        if(!list[i].dead) th += boosterThrust(list[i]);
    }
    return th * boosterPower() / cells;
}

function startBurn(b, s){
    var it = nextFuel(b);
    if(it == null) return;
    b.items.remove(it, 1);
    s.item = it;
    s.burn = FUEL_BURN_TICKS;
}

/** ticks between two puffs of smoke of a working booster (0 = no smoke) */
function smokeInterval(b){
    var rate = SMOKE_ROCKET_PER_SEC;
    if(b.block === fuelBooster) rate = SMOKE_FUEL_PER_SEC;
    else if(b.block === energyBooster) rate = SMOKE_ENERGY_PER_SEC;
    else if(b.block === reactorBooster) rate = SMOKE_REACTOR_PER_SEC;
    return rate > 0 ? 60 / rate : 0;
}

function randRange(r){ return (Math.random() * 2 - 1) * r; }

/** One puff of drill dust over the booster, placed the way Drill.updateTile places it (+-2 world units per tile of size).
 *  rocket booster = mechanical drill (Fx.pulverizeSmall), energy booster = laser drill (Fx.pulverizeMedium),
 *  fuel booster = pneumatic drill: its dust (Fx.pulverizeSmall) plus the puff of its drillEffect (Fx.mine),
 *  which a drill tints with the ore it mines: here it is tinted with the fuel that burns. The position is in the real
 *  world (the parts of a flying machine are put there before they are updated), so the smoke stays behind the machine. */
function emitSmoke(b, s){
    if(Vars.headless) return;
    var size = b.block.size, r = size * 2;
    if(b.block === energyBooster){
        Fx.pulverizeMedium.at(b.x + randRange(r), b.y + randRange(r));
        return;
    }
    Fx.pulverizeSmall.at(b.x + randRange(r), b.y + randRange(r));
    if(b.block === fuelBooster){
        var col = s.item != null ? s.item.color : Items.coal.color;
        Fx.mine.at(b.x + randRange(size), b.y + randRange(size), 0, col);
    }
    if(b.block === reactorBooster){
        Fx.mine.at(b.x + randRange(size), b.y + randRange(size), 0, Items.thorium.color);
    }
}

/** counts the time of a working booster and lets it puff exactly SMOKE_*_PER_SEC times per second */
function stepSmoke(b, s, delta){
    var iv = smokeInterval(b);
    if(iv <= 0) return;
    if(s.smoke < 0) s.smoke = Math.random() * iv;      // boosters do not all puff at the same moment
    s.smoke += delta;
    if(s.smoke >= iv){
        s.smoke -= iv;
        if(s.smoke > iv) s.smoke = 0;                  // a very long frame: no burst of puffs
        emitSmoke(b, s);
    }
}

/** after the blocks of a flying machine were updated: fuel is burnt, the glow of the engines follows their work */
function tickBoosters(m, delta){
    var list = m.boosters;
    for(var i = 0; i < list.length; i++){
        var b = list[i];
        if(b.dead) continue;
        var s = bstate(b);
        var working = false;
        if(s.thrusting){
            if(b.block === rocketBooster){
                working = true;
            }else if(b.block === energyBooster){
                working = b.power.status > 0.05;
            }else if(b.block === fuelBooster){
                if(s.burn <= 0) startBurn(b, s);      // the previous item is used up: take the next one
                if(s.burn > 0){
                    working = true;
                    s.burn -= delta;
                    if(s.burn < 0) s.burn = 0;
                }
            }else if(b.block === reactorBooster){
                var cryoAmt = 0;
                try{ cryoAmt = b.liquids != null ? Number(b.liquids.get(Liquids.cryofluid)) : 0; }catch(eC){ cryoAmt = 0; }
                var thorAmt = 0;
                try{ thorAmt = b.items != null ? b.items.get(Items.thorium) : 0; }catch(eT){ thorAmt = 0; }
                if(thorAmt > 0 || s.burn > 0) s.armed = true;
                // keep burning thorium whether cooled or not — no cryo means it still runs, but heats up
                if(s.burn <= 0 && thorAmt > 0){
                    b.items.remove(Items.thorium, 1);
                    s.item = Items.thorium;
                    s.burn = REACTOR_THORIUM_TICKS;
                }
                if(s.burn > 0){
                    working = true;
                    s.burn -= delta;
                    if(s.burn < 0) s.burn = 0;
                }
                if(cryoAmt > 0.5){
                    s.overheat = 0;           // cooled: safe
                }else if(s.armed && working){
                    // running without coolant → heat toward explosion (thrust stays on)
                    s.overheat = (s.overheat || 0) + delta;
                    if(s.overheat >= REACTOR_HEAT_TICKS){
                        // the block is destroyed the same way as by an enemy bullet: destroyPart makes the explosion (once),
                        // flyReconcile detaches what was held only by it (or removes the machine if nothing is left)
                        try{ damagePart(m, b, 1e9); }catch(eX){ logErr("reactor overheat", eX); }
                        if(machines.indexOf(m) < 0) return;
                        continue;
                    }
                }
            }
        }else if(b.block === reactorBooster){
            // not thrusting: cool very slowly so short stops cannot dodge the boom
            // heat rate = 1/tick while thrusting; cool rate ≈ 1/10 → ~40 s idle to clear a full 4 s heat bar
            if(s.overheat > 0) s.overheat = Math.max(0, s.overheat - delta * 0.1);
        }
        s.working = working;
        stepGlow(s, working);
        if(working){
            stepSmoke(b, s, delta);
            if(b.block !== rocketBooster) stepLiquid(b, s, delta);     // the boosting liquid is used up only while the engine works
        }
    }
}

function originShift(size){ // origin tile -> first covered tile offset
    return -Math.floor((size - 1) / 2);
}

/** covered tile positions of a building */
function coverTiles(b){
    var s = b.block.size, off = originShift(s), tx = b.tile.x, ty = b.tile.y, out = [];
    for(var dx = 0; dx < s; dx++){
        for(var dy = 0; dy < s; dy++){
            out.push(Point2.pack(tx + off + dx, ty + off + dy));
        }
    }
    return out;
}

/** center of a building in tile units (tile centers are integers) */
function centerOf(b){
    var s = b.block.size;
    return [b.tile.x + originShift(s) + (s - 1) / 2, b.tile.y + originShift(s) + (s - 1) / 2];
}

function sameTeam(b, team){
    return b != null && b.team.id == team.id;
}

/** block rotation that has to be passed to setBlock (turrets shadow the field with their own angle) */
function blockRot(b){
    return b.block.rotate ? (b.rotation | 0) : 0;
}

function countKeys(o){
    var n = 0;
    for(var k in o) n++;
    return n;
}

function normAngle(a){
    a = a % 360;
    return a < 0 ? a + 360 : a;
}

function signedDiff(to, from){ // shortest signed angle from -> to, in (-180, 180]
    var d = ((to - from) % 360 + 540) % 360 - 180;
    return d;
}

// ---- the front ("nose") of a machine: the green arrow of the build mode ----------------------------------
// A machine remembers which of its four sides is the front, as a block rotation index in the grid frame of the
// machine (0 right, 1 up, 2 left, 3 down). Up is the default, which is what machines always had.
var DEFAULT_FRONT = 1;

function frontIndex(m){
    return m.front === undefined || m.front === null ? DEFAULT_FRONT : (m.front | 0) & 3;
}

/** angle of the front of the machine in its own frame: 90 = up (it is turned by m.ang in the world) */
function frontDeg(m){
    return frontIndex(m) * 90;
}

/** turns the front by `steps` quarter turns (+1 = counterclockwise, like the R key of blocks) */
function turnFront(m, steps){
    m.front = (frontIndex(m) + steps + 4) & 3;
    saveDirty = true;
}

function frontFromSave(o){
    return o.fr === undefined || o.fr === null ? DEFAULT_FRONT : (o.fr | 0) & 3;
}

function toPoint2Array(list){
    var arr = Packages.java.lang.reflect.Array.newInstance(Packages.arc.math.geom.Point2, list.length);
    for(var i = 0; i < list.length; i++) arr[i] = list[i];
    return arr;
}

function components(blds){
    var cover = {};
    blds.forEach(b => coverTiles(b).forEach(p => { cover[p] = b; }));
    var seen = {}, comps = [];
    blds.forEach(b0 => {
        if(seen[b0.pos()]) return;
        var comp = [], stack = [b0];
        seen[b0.pos()] = true;
        while(stack.length){
            var b = stack.pop();
            comp.push(b);
            coverTiles(b).forEach(p => {
                var x = Point2.x(p), y = Point2.y(p);
                for(var i = 0; i < 4; i++){
                    var o = cover[Point2.pack(x + DIRS[i][0], y + DIRS[i][1])];
                    if(o != null && !seen[o.pos()]){
                        seen[o.pos()] = true;
                        stack.push(o);
                    }
                }
            });
        }
        comps.push(comp);
    });
    return comps;
}

function cellsOf(blds){
    var cells = {};
    blds.forEach(b => coverTiles(b).forEach(p => { cells[p] = true; }));
    return cells;
}

// ---------------------------------------------------------------------------
//  machine registry
// ---------------------------------------------------------------------------
function reindexAll(){
    layoutVersion++;
    cellIndex = {};
    partIndex = {};
    machines.forEach(m => {
        if(m.mode == "land"){
            for(var k in m.cells) cellIndex[k] = m;
        }else{
            m.parts.forEach(b => { partIndex[b.id] = m; });
        }
    });
}

function machineOfBuild(b){          // landed machines only
    if(b == null || b.tile == null) return null;
    return cellIndex[Point2.pack(b.tile.x, b.tile.y)] || null;
}

function machineAtTile(tile){        // landed machines only
    if(tile == null) return null;
    return cellIndex[tile.pos()] || null;
}

// (plain loops: these two are called many times per frame, the closure of filter() and its garbage added up)
function landedMachines(){
    var out = [];
    for(var i = 0; i < machines.length; i++) if(machines[i].mode == "land") out.push(machines[i]);
    return out;
}

function flyingMachines(){
    var out = [];
    for(var i = 0; i < machines.length; i++) if(machines[i].mode == "fly") out.push(machines[i]);
    return out;
}

/** the main hull building of a machine (real building when landed, pocket building when flying) */
function hullBuild(m){
    if(m.mode == "fly"){
        var h = m.hull;
        return h != null && !h.dead && partIndex[h.id] === m ? h : null;
    }
    var b = Vars.world.build(m.anchor);
    return isHull(b) && sameTeam(b, m.team) ? b : null;
}

/** world position of the machine's reference point (hull center) */
function machinePos(m){
    if(m.mode == "fly") return [m.x, m.y];
    var h = hullBuild(m);
    return h == null ? [m.x, m.y] : [h.x, h.y];
}

function membersOf(cells, team){
    var seen = {}, out = [];
    for(var k in cells){
        var b = Vars.world.build(+k);
        if(b != null && sameTeam(b, team)){
            var key = b.pos();
            if(!seen[key]){
                seen[key] = true;
                out.push(b);
            }
        }
    }
    return out;
}

function createMachine(hull){
    // multiplayer: only the host owns the machine registry; clients only draw flying ghosts (netMachines)
    if(Vars.net.client()) return null;
    var m = {
        id: nextId++, team: hull.team, mode: "land",
        anchor: hull.pos(), cells: cellsOf([hull]), pending: {},
        parts: [], hull: null, pocket: null, off: [0, 0], ref: [0, 0], realTiles: null,
        x: hull.x, y: hull.y, ang: 0, savedAng: 0, vx: 0, vy: 0, radius: 12,
        body: null, stats: null, oreCache: {}, oreStamp: 0, oreTimer: 0, lastOre: [0, 0, 0],
        target: null, targetTimer: 0, turrets: [], boosters: [], thrusting: false, flip: 0, progress: 0,
        front: 1, parked: false
    };
    machines.push(m);
    reindexAll();
    saveDirty = true;
    dirty = true;           // loose blocks that were ready before this hull are attached in processDirty
    return m;
}

function dropMachine(m){
    var i = machines.indexOf(m);
    if(i >= 0) machines.splice(i, 1);
    removeBody(m);
    if(poss != null && poss.m === m) endPossession(true, "machine dropped");
    reindexAll();
    saveDirty = true;
}

function machineStats(m){
    var blds = m.mode == "fly" ? m.parts : membersOf(m.cells, m.team);
    var boosters = 0, cells = 0, thrust = 0;
    blds.forEach(b => {
        if(isBooster(b)){
            boosters++;
            if(!isConstructing(b)) thrust += boosterThrust(b);
        }
        cells += b.block.size * b.block.size;
    });
    var speed = cells > 0 ? thrust * boosterPower() / cells : 0;
    return {blocks: blds.length, boosters: boosters, cells: cells, speed: speed};
}

// ---------------------------------------------------------------------------
//  pocket world: a private tile array in which the blocks of a flying machine live
// ---------------------------------------------------------------------------
function mkPocketTile(m, x, y){
    return extend(Tile, x, y, {
        // a pocket must never talk to the real world: no events, no renderer, no indexer, no entity groups
        fireChanged(){},
        firePreChanged(){},
        recache(){},
        recacheWall(){},
        changeBuild(team, prov, rot){
            this.build = null;
            if(this.block.hasBuilding()) this.build = prov.get().init(this, team, false, rot);
        },
        // ore / sand under the flying drill, sampled from the real world below it
        drop(){ return oreAt(m, this); },
        // the floor under a flying pump: the liquid floor the cell touches (a pump takes its liquid from it), else plain stone
        floor(){
            var f = liquidFloorAt(m, this);
            return f != null ? f : Blocks.stone;
        }
    });
}

function makePocket(m, w, h){
    m.pocket = new Tiles(w, h);
    for(var x = 0; x < w; x++){
        for(var y = 0; y < h; y++) m.pocket.set(x, y, mkPocketTile(m, x, y));
    }
    m.pw = w;
    m.ph = h;
}

/** runs fn with world.tiles swapped to the pocket of m. structural = placing / removing blocks (renderer is bypassed) */
function withPocket(m, fn, structural){
    var w = Vars.world, old = w.tiles, hd = Vars.headless;
    if(old === m.pocket) return fn();
    m.realTiles = old;
    w.tiles = m.pocket;
    inPocketOp++;
    if(structural) Vars.headless = true;
    try{
        return fn();
    }finally{
        if(structural) Vars.headless = hd;
        inPocketOp--;
        w.tiles = old;
    }
}

// ---- pose helpers: pocket world units <-> real world units
function toWorld(m, px, py){
    var lx = px - m.ref[0] * TS, ly = py - m.ref[1] * TS;
    var c = Mathf.cosDeg(m.ang), s = Mathf.sinDeg(m.ang);
    return [m.x + lx * c - ly * s, m.y + lx * s + ly * c];
}

function toLocal(m, wx, wy){
    var dx = wx - m.x, dy = wy - m.y;
    var c = Mathf.cosDeg(m.ang), s = Mathf.sinDeg(m.ang);
    return [m.ref[0] * TS + dx * c + dy * s, m.ref[1] * TS - dx * s + dy * c];
}

/** turns the machine; flying turrets turn with the hull */
function setAng(m, ang){
    var delta = ang - m.ang;
    if(delta != 0 && m.mode == "fly"){
        for(var i = 0; i < m.parts.length; i++){
            var b = m.parts[i];
            if(isTurret(b) || isTractor(b) || b.block instanceof MassDriverClass) b.rotation = b.rotation + delta;
        }
    }
    m.ang = normAngle(ang);
}

// ---- ore under a flying drill: any touch of the footprint with ore counts
function oreAt(m, tile){
    var key = tile.x * 1024 + tile.y;
    var c = m.oreCache[key];
    if(c !== undefined && c.stamp == m.oreStamp) return c.item;
    var item = sampleOre(m, tile.x, tile.y);
    m.oreCache[key] = {stamp: m.oreStamp, item: item};
    return item;
}

/** area of the polygon poly (flat [x0,y0,x1,y1,...]) clipped to the box [x0,x1]x[y0,y1] (Sutherland-Hodgman) */
function clippedArea(poly, bx0, by0, bx1, by1){
    var edges = [[0, bx0, 1], [0, bx1, -1], [1, by0, 1], [1, by1, -1]];
    var pts = [];
    for(var i = 0; i < poly.length; i += 2) pts.push([poly[i], poly[i + 1]]);
    for(var e = 0; e < 4; e++){
        var ax = edges[e][0], lim = edges[e][1], sg = edges[e][2];
        var out = [];
        for(var k = 0; k < pts.length; k++){
            var p = pts[k], q = pts[(k + 1) % pts.length];
            var pin = (p[ax] - lim) * sg >= 0, qin = (q[ax] - lim) * sg >= 0;
            if(pin) out.push(p);
            if(pin != qin){
                var t = (lim - p[ax]) / (q[ax] - p[ax]);
                out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
            }
        }
        pts = out;
        if(pts.length < 3) return 0;
    }
    var area = 0;
    for(var j = 0; j < pts.length; j++){
        var u = pts[j], v = pts[(j + 1) % pts.length];
        area += u[0] * v[1] - v[0] * u[1];
    }
    return Math.abs(area) / 2;
}

/** the real tiles a flying cell (pocket tile tx, ty) overlaps, each with the area of the overlap: [{t: tile, a: area}] */
function cellOverlaps(m, tx, ty){
    var rt = m.realTiles, out = [];
    if(rt == null || m.mode != "fly") return out;
    var poly = [], minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
    var cs = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]];
    for(var i = 0; i < 4; i++){
        var w = toWorld(m, (tx + cs[i][0]) * TS, (ty + cs[i][1]) * TS);
        var wx = w[0] / TS, wy = w[1] / TS;   // tile units: tile k spans k-0.5 .. k+0.5
        poly.push(wx, wy);
        minX = Math.min(minX, wx); maxX = Math.max(maxX, wx);
        minY = Math.min(minY, wy); maxY = Math.max(maxY, wy);
    }
    for(var kx = Math.round(minX); kx <= Math.round(maxX); kx++){
        for(var ky = Math.round(minY); ky <= Math.round(maxY); ky++){
            var t = rt.get(kx, ky);
            if(t == null) continue;
            var ar = clippedArea(poly, kx - 0.5, ky - 0.5, kx + 0.5, ky + 0.5);
            if(ar >= 0.001) out.push({t: t, a: ar});
        }
    }
    return out;
}

/** the liquid floor a flying cell touches: any touch counts (like the ore of a drill), the biggest touched liquid floor wins */
function liquidFloorAt(m, tile){
    var key = "L" + (tile.x * 1024 + tile.y);
    var c = m.oreCache[key];
    if(c !== undefined && c.stamp == m.oreStamp) return c.floor;
    var areas = {}, floors = {}, best = null, bestA = 0;
    cellOverlaps(m, tile.x, tile.y).forEach(o => {
        var f = o.t.floor();
        if(f == null || f.liquidDrop == null) return;
        areas[f.id] = (areas[f.id] || 0) + o.a;
        floors[f.id] = f;
    });
    for(var id in areas){
        if(areas[id] > bestA){ bestA = areas[id]; best = floors[id]; }
    }
    m.oreCache[key] = {stamp: m.oreStamp, floor: best};
    return best;
}

/** the ore a flying cell lies on: every real tile the cell overlaps (by any area) counts, the biggest overlap wins */
function sampleOre(m, tx, ty){
    var areas = {}, items = {};
    cellOverlaps(m, tx, ty).forEach(o => {
        var d = o.t.drop();
        if(d == null) return;
        areas[d.id] = (areas[d.id] || 0) + o.a;
        items[d.id] = d;
    });
    var best = null, bestA = 0;
    for(var id in areas){
        var it = items[id], a = areas[id];
        // like a drill: ore beats low priority items (sand), then the bigger share, then the lower id
        var better = best == null
            || (best.lowPriority && !it.lowPriority)
            || (best.lowPriority == it.lowPriority && (a > bestA + 1e-6 || (Math.abs(a - bestA) <= 1e-6 && it.id < best.id)));
        if(better){ best = it; bestA = a; }
    }
    return best;
}

function refreshOre(m){
    m.oreStamp++;
    withPocket(m, () => {
        m.parts.forEach(b => {
            // drills read the ore under them, pumps the liquid floor under them (see floor() of the pocket tiles)
            if(b.block instanceof Drill || isPumpBlock(b.block)) b.onProximityUpdate();
        });
    }, false);
    m.lastOre = [m.x, m.y, m.ang];
}

// ---------------------------------------------------------------------------
//  position based configs (bridges, power nodes ...) survive a move
// ---------------------------------------------------------------------------
function configToAbs(b){
    // ship control: resource + options
    if(isShipControl(b)){
        return {
            kind: 3,
            val: shipCfg[b.id] == null ? null : shipCfg[b.id],
            opt: shipOptCode(b)
        };
    }
    var cfg = null;
    try{ cfg = b.config(); }catch(e){ cfg = null; }
    // bridges / mass drivers: Point2 relative → absolute tile
    if(cfg instanceof Point2){
        return {kind: 1, abs: [Point2.pack(b.tile.x + cfg.x, b.tile.y + cfg.y)]};
    }
    // power nodes etc.: array of Point2
    try{
        if(cfg != null && cfg.length !== undefined && cfg.length > 0 && (cfg[0] instanceof Point2)){
            var abs = [];
            for(var i = 0; i < cfg.length; i++) abs.push(Point2.pack(b.tile.x + cfg[i].x, b.tile.y + cfg[i].y));
            return {kind: 2, abs: abs};
        }
    }catch(eA){}
    // unloader / sorter / filter: selected Item
    try{
        if(cfg instanceof Item) return {kind: 4, item: cfg.name};
    }catch(eI){}
    // liquid filters
    try{
        if(cfg instanceof Liquid) return {kind: 5, liquid: cfg.name};
    }catch(eL){}
    // plain values (boolean / number / string configs)
    if(cfg === true || cfg === false || typeof cfg === "number" || typeof cfg === "string"){
        return {kind: 6, val: cfg};
    }
    // ItemBridge-style link stored as packed absolute tile (fallback if config() was null)
    try{
        if((cfg == null || cfg === undefined) && b.link !== undefined && b.link != null && b.link != -1){
            return {kind: 1, abs: [b.link | 0]};
        }
    }catch(eLink){}
    // ItemSource / Sorter / Unloader sometimes expose the item only as a field
    try{
        if((cfg == null || cfg === undefined) && b.sortItem != null) return {kind: 4, item: b.sortItem.name};
    }catch(eS){}
    try{
        if((cfg == null || cfg === undefined) && b.outputItem != null) return {kind: 4, item: b.outputItem.name};
    }catch(eO){}
    return null;
}

function applyConfigAbs(b, c, mapFn){
    if(c == null || b == null) return;
    if(c.kind == 3){
        shipSetCfg(b, c.val);
        if(c.opt) try{ shipOptFrom(b, c.opt); }catch(eO){}
        return;
    }
    if(c.kind == 4){
        try{
            var it = Vars.content.item(c.item);
            if(it != null) b.configured(null, it);
        }catch(e){ Log.err("[mb] item config restore failed: " + e); }
        return;
    }
    if(c.kind == 5){
        try{
            var lq = Vars.content.liquid(c.liquid);
            if(lq != null) b.configured(null, lq);
        }catch(e){ Log.err("[mb] liquid config restore failed: " + e); }
        return;
    }
    if(c.kind == 6){
        try{ b.configured(null, c.val); }catch(e){ Log.err("[mb] value config restore failed: " + e); }
        return;
    }
    // kind 1 / 2: position links (bridges, power nodes, drivers)
    if(c.abs == null || mapFn == null) return;
    try{
        var rel = [];
        for(var i = 0; i < c.abs.length; i++){
            var q = mapFn(c.abs[i]);
            if(q == null) continue;
            rel.push(new Point2(Point2.x(q) - b.tile.x, Point2.y(q) - b.tile.y));
        }
        if(rel.length == 0) return;
        if(c.kind == 1) b.configured(null, rel[0]);
        else b.configured(null, toPoint2Array(rel));
    }catch(e){
        Log.err("[mb] config restore failed: " + e);
    }
}

/** second pass for bridges / nodes after every block exists on the new layer */
function applyAllConfigs(plans, mapFn){
    plans.forEach(p => { try{ applyConfigAbs(p.b, p.cfg, mapFn); }catch(e){} });
    // bridges often need both ends present; run position configs again
    plans.forEach(p => {
        if(p.cfg != null && (p.cfg.kind == 1 || p.cfg.kind == 2)){
            try{ applyConfigAbs(p.b, p.cfg, mapFn); }catch(e){}
        }
    });
}

function refund(b){
    try{
        var core = b.team.core();
        if(core == null) return;
        var mult = Vars.state.rules.deconstructRefundMultiplier;
        var reqs = b.block.requirements;
        for(var i = 0; i < reqs.length; i++){
            var amount = Math.floor(reqs[i].amount * mult);
            var room = core.getMaximumAccepted(reqs[i].item) - core.items.get(reqs[i].item);
            if(amount > 0 && room > 0) core.items.add(reqs[i].item, Math.min(amount, room));
        }
    }catch(e){
        Log.err("[mb] refund failed: " + e);
    }
}

// ---------------------------------------------------------------------------
//  landed machines (build mode): attachment check, merging, cell steps
// ---------------------------------------------------------------------------
function touches(m, b){
    var cov = coverTiles(b);
    for(var i = 0; i < cov.length; i++){
        var x = Point2.x(cov[i]), y = Point2.y(cov[i]);
        for(var d = 0; d < 4; d++){
            var p = Point2.pack(x + DIRS[d][0], y + DIRS[d][1]);
            if(m.cells[p] || m.pending[p]) return true;
        }
    }
    return false;
}

/** Landed machines that touch each other are joined into one machine (build mode: a block placed between two machines
 *  connects them). A PARKED machine (landed with the "Land" order / the park button, see landMachine) is never joined with
 *  anything: a group of machines that parked side by side must take off again as the same separate machines. */
function mergeTouching(m){
    var merged = false;
    if(m.parked) return false;
    for(var guard = 0; guard < 8; guard++){
        var other = null;
        for(var k in m.cells){
            var x = Point2.x(+k), y = Point2.y(+k);
            for(var d = 0; d < 4 && other == null; d++){
                var o = cellIndex[Point2.pack(x + DIRS[d][0], y + DIRS[d][1])];
                if(o != null && o !== m && !o.parked && o.team.id == m.team.id) other = o;
            }
            if(other != null) break;
        }
        if(other == null) break;
        for(var k1 in other.cells) m.cells[k1] = true;
        for(var k2 in other.pending) m.pending[k2] = true;
        if(poss != null && poss.m === other) poss.m = m;
        var i = machines.indexOf(other);
        if(i >= 0) machines.splice(i, 1);
        removeBodyKeepPossession(other);
        reindexAll();
        merged = true;
    }
    return merged;
}

/** returns number of removed orphan blocks (only when removeNow) */
function reconcile(m, removeNow){
    if(busy || machines.indexOf(m) < 0 || m.mode != "land") return 0;
    // candidates: current members + blocks placed during build mode that are not attached yet
    var cand = {};
    for(var k in m.cells) cand[k] = true;
    for(var k2 in m.pending) cand[k2] = true;
    var blds = membersOf(cand, m.team);
    var comps = components(blds);

    var sp = splitGroups(comps, hullBuild(m));
    var good = sp.good, bad = sp.bad;
    // a parked machine outside the build mode is not being edited: what lost its hold (destroyed hull, shot-off parts) is
    // simply let go as ordinary blocks of the world, nothing is taken down and no red marks stay behind
    var soft = m.parked && !anyBuild() && !removeNow;

    if(good.length == 0){
        // the hull is gone
        if(soft){
            m.pending = {};
            dropMachine(m);
            return 0;
        }
        if(!removeNow){
            m.cells = {};
            m.pending = cellsOf(bad);
            reindexAll();
            return 0;
        }
        var n = 0;
        bad.forEach(b => {
            refund(b);
            busy = true;
            try{ b.tile.remove(); }finally{ busy = false; }
            n++;
        });
        dropMachine(m);
        return n;
    }

    m.cells = cellsOf(good);
    // keep a valid anchor
    if(hullBuild(m) == null){
        var h = good.filter(isHull)[0];
        m.anchor = h.pos();
    }

    var removed = 0;
    if(!removeNow){
        m.pending = soft ? {} : cellsOf(bad);
    }else{
        m.pending = {};
        bad.forEach(b => {
            refund(b);
            busy = true;
            try{ b.tile.remove(); }finally{ busy = false; }
            removed++;
        });
    }
    reindexAll();
    mergeTouching(m);
    saveDirty = true;
    return removed;
}

/** does building b touch a block that really belongs to machine m (pending blocks do not count) */
function touchesCells(m, b){
    var cov = coverTiles(b);
    for(var i = 0; i < cov.length; i++){
        var x = Point2.x(cov[i]), y = Point2.y(cov[i]);
        for(var d = 0; d < 4; d++){
            if(m.cells[Point2.pack(x + DIRS[d][0], y + DIRS[d][1])]) return true;
        }
    }
    return false;
}

/** The loose blocks (see `loose`) that touch a landed machine join it; repeated, because a block may touch only a block
 *  that has just joined. This is what attaches a whole pasted schematic once its core / storage is built.
 *  Returns the machines that gained blocks. */
function adoptLoose(){
    var gained = [];
    var landed = landedMachines();
    // forget what is gone, was taken by a machine already or is still under construction
    var list = [], seen = {};
    for(var k in loose){
        var b = Vars.world.build(+k);
        if(b == null || b.tile == null || machineOfBuild(b) != null){ delete loose[k]; continue; }
        if(isConstructing(b)) continue;
        if(seen[b.pos()]) continue;
        seen[b.pos()] = true;
        list.push(b);
    }
    if(landed.length == 0 || list.length == 0) return gained;
    var progress = true;
    var guard = 0;
    while(progress && list.length > 0 && guard++ < 64){
        progress = false;
        for(var i = list.length - 1; i >= 0; i--){
            var blk = list[i], owner = null;
            for(var j = 0; j < landed.length && owner == null; j++){
                if(landed[j].team.id == blk.team.id && touchesCells(landed[j], blk)) owner = landed[j];
            }
            if(owner == null) continue;
            coverTiles(blk).forEach(p => { owner.cells[p] = true; delete loose[p]; });
            if(gained.indexOf(owner) < 0) gained.push(owner);
            list.splice(i, 1);
            progress = true;
        }
    }
    if(gained.length > 0) reindexAll();
    return gained;
}

/** the build mode ends: loose blocks that found no machine are taken down (the cost is refunded); returns how many */
function purgeLoose(pid){
    adoptLoose();
    var seen = {}, n = 0, mine = pid == null ? null : "p" + pid;
    var keys = Object.keys(loose);
    for(var ki = 0; ki < keys.length; ki++){
        var k = keys[ki], owner = loose[k];
        // the blocks of another player who is still in his build mode are not touched
        if(mine != null && owner !== true && owner !== "p" && owner !== mine) continue;
        delete loose[k];
        var b = Vars.world.build(+k);
        if(b == null || b.tile == null || isConstructing(b) || seen[b.pos()]) continue;
        if(machineOfBuild(b) != null) continue;
        seen[b.pos()] = true;
        refund(b);
        var wasBusy = busy;
        busy = true;
        try{ b.tile.remove(); }finally{ busy = wasBusy; }
        n++;
    }
    return n;
}

function planMove(m, dx, dy){
    var blds = membersOf(m.cells, m.team);
    var anchor = hullBuild(m);
    if(anchor == null) return {ok: false, why: "noanchor"};
    var own = {};
    blds.forEach(b => coverTiles(b).forEach(p => { own[p] = true; }));

    var used = {}, plans = [];
    for(var i = 0; i < blds.length; i++){
        var b = blds[i];
        if(isConstructing(b)) return {ok: false, why: "constructing"};
        var s = b.block.size, off = originShift(s);
        for(var ax = 0; ax < s; ax++){
            for(var ay = 0; ay < s; ay++){
                var x = b.tile.x + dx + off + ax, y = b.tile.y + dy + off + ay;
                var t = Vars.world.tile(x, y);
                if(t == null) return {ok: false, why: "edge"};
                var p = t.pos();
                if(used[p]) return {ok: false, why: "overlap"};
                used[p] = true;
                if(!own[p]){
                    var bl = t.block();
                    if(t.build != null) return {ok: false, why: "blocked"};
                    if(bl != Blocks.air && !bl.alwaysReplace) return {ok: false, why: "blocked"};
                }
                var f = t.floor();
                if(f.solid) return {ok: false, why: "blocked"};
                if(f.isDeep() && !(b.block.floating || b.block.placeableLiquid || b.block.requiresWater)) return {ok: false, why: "water"};
                if(Vars.world.getDarkness(x, y) >= 3) return {ok: false, why: "edge"};
            }
        }
        plans.push({x: b.tile.x + dx, y: b.tile.y + dy, rot: blockRot(b)});
    }
    return {ok: true, blds: blds, plans: plans, dx: dx, dy: dy};
}

function placeReal(block, team, rot, b, x, y){
    var t = Vars.world.tile(x, y);
    t.setBlock(block, team, rot, prov(() => b));
    b.dropped();
}

function applyMove(m, tr){
    var blds = tr.blds, plans = tr.plans;
    var wasBusy = busy;
    busy = true;
    try{
        var cfgs = blds.map(b => configToAbs(b));
        var memberCover = {};
        blds.forEach(b => coverTiles(b).forEach(p => { memberCover[p] = true; }));
        var anchorIdx = blds.findIndex(b => b.pos() == m.anchor);   // before anything moves
        var blocks = blds.map(b => b.block), teams = blds.map(b => b.team);
        blds.forEach(b => b.pickedUp());
        blds.forEach(b => b.tile.setBlock(Blocks.air));
        blds.forEach(b => b.afterPickedUp());

        var mapPos = p => {
            if(!memberCover[p]) return null;
            return Point2.pack(Point2.x(p) + tr.dx, Point2.y(p) + tr.dy);
        };
        for(var i = 0; i < blds.length; i++) placeReal(blocks[i], teams[i], plans[i].rot, blds[i], plans[i].x, plans[i].y);
        for(var j = 0; j < blds.length; j++) applyConfigAbs(blds[j], cfgs[j], mapPos);
        for(var j2 = 0; j2 < blds.length; j2++){
            if(cfgs[j2] != null && (cfgs[j2].kind == 1 || cfgs[j2].kind == 2))
                try{ applyConfigAbs(blds[j2], cfgs[j2], mapPos); }catch(e2){}
        }

        if(anchorIdx >= 0) m.anchor = Point2.pack(plans[anchorIdx].x, plans[anchorIdx].y);
        m.cells = cellsOf(blds);
        // m.pending is kept: the unattached (red) blocks did not move with the machine, they are still unattached.
        // (They used to be forgotten here, which turned them into plain world blocks - blue - on the first step.)
        reindexAll();
        dirty = true;       // ... but the step may have brought the machine next to them: attachment is checked again
        saveDirty = true;
    }finally{
        busy = wasBusy;
    }
}

function stepMachine(m, dir){
    var tr = planMove(m, DIRS[dir][0], DIRS[dir][1]);
    if(!tr.ok) return tr.why;
    applyMove(m, tr);
    return "ok";
}

// ---------------------------------------------------------------------------
//  the body unit of a machine: gives the player something to control and enemies something to aim at
// ---------------------------------------------------------------------------
function ensureBody(m){
    if(m.body != null && m.body.isValid()) return m.body;
    var pos = machinePos(m);
    var d = driverType.spawn(m.team, pos[0], pos[1]);
    d.hitSize = Math.max(8, m.radius * 2);
    try{ d.flag = m.id; }catch(eF){}   // client can correlate unit <-> machine id
    m.body = d;
    try{
        if(!d.isCommandable()){
            // a body made while a world is loading may come without the RTS controller: give it one, or the machine
            // cannot be picked in the command mode
            Log.info("[mb] a new body could not take orders, giving it a CommandAI");
            d.controller(new Packages.mindustry.ai.types.CommandAI());
        }
    }catch(e){ logErr("body command ai", e); }
    return d;
}

function removeBody(m){
    if(m.body != null){
        try{ if(m.body.isValid()) m.body.remove(); }catch(e){ logErr("removeBody", e); }
        m.body = null;
    }
}

function removeBodyKeepPossession(m){
    // used when machine `m` was merged into another one: the player keeps driving through the survivor
    if(poss != null && m.body != null && Vars.player != null && Vars.player.unit() == m.body){
        var survivor = poss.m;
        var pos = machinePos(survivor);
        var d = ensureBody(survivor);
        Vars.player.unit(d);
    }
    removeBody(m);
}

// The body's hitSize is the diameter of the machine: the formation of a group (UnitGroup), the click area and the reach of
// enemy fire are all computed from it. But the game also draws things whose size is proportional to hitSize: the hexagon
// round a unit selected in the RTS mode, the four arrows round a unit under the cursor while Ctrl is held, and the squares
// of the "you control this unit" effect (Fx.unitControl). Round a whole machine they came out far too big. So while a
// frame is DRAWN (Trigger.draw .. Trigger.postDraw) the bodies are HIT_DRAW_SCALE times their size; the game logic never
// sees it, and restoreBodies() also runs at the start of every update, in case a frame was cut short.
var HIT_DRAW_SCALE = 0.5;
var shrunkBodies = [];      // [body, its real hitSize] while the frame is drawn

function shrinkBodies(){
    if(shrunkBodies.length > 0) return;
    for(var i = 0; i < machines.length; i++){
        var d = machines[i].body;
        try{
            if(d == null || !d.isValid()) continue;
            var full = d.hitSize;
            shrunkBodies.push([d, full]);
            d.hitSize = full * HIT_DRAW_SCALE;
        }catch(e){
            logErr("shrinkBodies", e);
        }
    }
}

function restoreBodies(){
    for(var i = 0; i < shrunkBodies.length; i++){
        try{
            shrunkBodies[i][0].hitSize = shrunkBodies[i][1];
        }catch(e){
            logErr("restoreBodies", e);
        }
    }
    shrunkBodies = [];
}

function keepBody(m){
    var d = m.body;
    if(d == null) return;
    if(!d.isValid()){ m.body = null; return; }
    var pos = machinePos(m);
    d.set(pos[0], pos[1]);
    d.vel.setZero();
    d.health = d.maxHealth;
}

// ---------------------------------------------------------------------------
//  parts bookkeeping of a flying machine
// ---------------------------------------------------------------------------
function partsChanged(m){
    m.turrets = m.parts.filter(isTurret);
    m.boosters = m.parts.filter(isBooster);
    m.stats = machineStats(m);
    var r = 8;
    m.parts.forEach(b => {
        var c = centerOf(b);
        var d = Math.sqrt(Math.pow((c[0] - m.ref[0]) * TS, 2) + Math.pow((c[1] - m.ref[1]) * TS, 2)) + b.block.size * TS * 0.75;
        if(d > r) r = d;
    });
    m.radius = r;
    if(m.body != null && m.body.isValid()) m.body.hitSize = Math.max(8, r * 2);
    reindexAll();
}

/** real world coordinates for every block of a flying machine (the game logic and other mods expect them) */
function setPartsReal(m){
    var c = Mathf.cosDeg(m.ang), s = Mathf.sinDeg(m.ang);
    var rx = m.ref[0] * TS, ry = m.ref[1] * TS;
    for(var i = 0; i < m.parts.length; i++){
        var b = m.parts[i];
        var lx = b.tile.drawx() - rx, ly = b.tile.drawy() - ry;
        b.set(m.x + lx * c - ly * s, m.y + lx * s + ly * c);
    }
}

/** pocket coordinates: needed only while the blocks are drawn through the batch transform */
function setPartsPocket(m){
    for(var i = 0; i < m.parts.length; i++){
        var b = m.parts[i];
        b.set(b.tile.drawx(), b.tile.drawy());
    }
}

function placeInPocket(m, p){
    var t = m.pocket.get(p.px, p.py);
    t.setBlock(p.block, p.team, p.rot, prov(() => p.b));
    p.b.dropped();
}

// ---------------------------------------------------------------------------
//  take off (grid -> pocket) and land (pocket -> grid)
// ---------------------------------------------------------------------------
/** clear a world tile; the clients get it with the batch of changed tiles (netFlushTiles), one packet for the whole machine */
function clearWorldTile(tile){
    if(tile == null) return;
    try{ tile.setBlock(Blocks.air); }catch(e){ logErr("clearWorldTile", e); }
}

function takeOff(m){
    if(m.mode == "fly") return true;
    if(Vars.net.client()) return false;   // only the host lifts machines
    // refresh membership from the grid before leaving (avoids leaving orphan blocks on the ground)
    try{ reconcile(m, false); }catch(eR){}
    var parts = membersOf(m.cells, m.team);
    var hull = hullBuild(m);
    if(parts.length == 0 || hull == null) return false;
    for(var i = 0; i < parts.length; i++){
        if(isConstructing(parts[i])){ say("mb.msg.constructing2"); return false; }
    }
    var minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    parts.forEach(b => coverTiles(b).forEach(p => {
        var x = Point2.x(p), y = Point2.y(p);
        if(x < minX) minX = x;
        if(x > maxX) maxX = x;
        if(y < minY) minY = y;
        if(y > maxY) maxY = y;
    }));
    if(maxX - minX + 1 > MAX_EXTENT || maxY - minY + 1 > MAX_EXTENT){ say("mb.msg.toolarge2", MAX_EXTENT); return false; }

    m.off = [minX - POCKET_MARGIN, minY - POCKET_MARGIN];
    var hc = centerOf(hull);
    m.ref = [hc[0] - m.off[0], hc[1] - m.off[1]];
    m.x = hull.x; m.y = hull.y; m.ang = 0; m.vx = 0; m.vy = 0;
    m.parked = false;
    m.oreCache = {}; m.oreStamp = 0;

    var memberCover = {};
    parts.forEach(b => coverTiles(b).forEach(p => { memberCover[p] = true; }));
    var plans = parts.map(b => ({
        block: b.block, team: b.team, rot: blockRot(b), b: b,
        px: b.tile.x - m.off[0], py: b.tile.y - m.off[1], cfg: configToAbs(b)
    }));

    try{
        parts.forEach(b => { if(b.block instanceof MassDriverClass) mdPos[b.id] = b.tile.pos(); });
    }catch(eMd){ logErr("remember driver places", eMd); }

    // build pocket BEFORE flipping mode / removing world blocks (safer on failure)
    try{
        makePocket(m, maxX - minX + 1 + 2 * POCKET_MARGIN, maxY - minY + 1 + 2 * POCKET_MARGIN);
    }catch(ePock){
        logErr("makePocket", ePock);
        return false;
    }

    var wasBusy = busy;
    busy = true;
    try{
        parts.forEach(b => { try{ b.pickedUp(); }catch(e){} });
        // clear every covered world tile (not only origins) and sync on server
        for(var ck in memberCover){
            var ct = Vars.world.tile(Point2.x(+ck), Point2.y(+ck));
            clearWorldTile(ct);
        }
        parts.forEach(b => { try{ b.afterPickedUp(); }catch(e){} });
        withPocket(m, () => {
            plans.forEach(p => placeInPocket(m, p));
            var mapPos = q => memberCover[q] ? Point2.pack(Point2.x(q) - m.off[0], Point2.y(q) - m.off[1]) : null;
            applyAllConfigs(plans, mapPos);
        }, true);
    }catch(eTake){
        logErr("takeOff transfer", eTake);
        busy = wasBusy;
        return false;
    }finally{
        busy = wasBusy;
    }

    // only now mark as flying
    m.mode = "fly";
    m.parts = parts;
    m.hull = hull;
    m.cells = {}; m.pending = {};
    refreshOre(m);
    partsChanged(m);
    setAng(m, m.savedAng || 0);
    setPartsReal(m);
    ensureBody(m);
    keepBody(m);
    saveDirty = true;
    try{
        if(isNetHost()){
            var sig = netSigOf(m);
            netSig[m.id] = sig;
            netSend(true, "mb-struct", netEncodeStruct(m, sig));
            netSend(false, "mb-pose", m.id + "," + m.x.toFixed(1) + "," + m.y.toFixed(1) + "," + m.ang.toFixed(1));
            netFlushTiles();             // the blocks leave the ground after the picture of the machine is there
            Log.info("[mb] machine " + m.id + " took off: " + m.parts.length + " blocks, picture sent");
        }
    }catch(eNet){ logErr("takeOff net", eNet); }
    return true;
}

/** tile offsets (pocket -> real) around the current position, nearest first */
var spiral = null;
function spiralOffsets(r){
    if(spiral != null && spiral.r == r) return spiral.list;
    var list = [];
    for(var x = -r; x <= r; x++) for(var y = -r; y <= r; y++) list.push([x, y]);
    list.sort((a, b) => (a[0] * a[0] + a[1] * a[1]) - (b[0] * b[0] + b[1] * b[1]));
    spiral = {r: r, list: list};
    return list;
}

function fitsOnGrid(m, off){
    var used = {}, tilesAll = 0, tilesDeep = 0;
    for(var i = 0; i < m.parts.length; i++){
        var b = m.parts[i];
        var cov = coverTiles(b);
        for(var j = 0; j < cov.length; j++){
            var x = Point2.x(cov[j]) + off[0], y = Point2.y(cov[j]) + off[1];
            var t = Vars.world.tile(x, y);
            if(t == null || t.build != null) return false;
            var bl = t.block();
            if(bl != Blocks.air && !bl.alwaysReplace) return false;
            var f = t.floor();
            if(f.solid) return false;
            if(f.isDeep() && !(b.block.floating || b.block.placeableLiquid || b.block.requiresWater)) return false;
            if(Vars.world.getDarkness(x, y) >= 3) return false;
            tilesAll++;
            if(f.isDeep()) tilesDeep++;
        }
    }
    // a machine that stands wholly on deep water could not move and, without fuel, could not take off again
    if(tilesAll > 0 && tilesDeep >= tilesAll) return false;
    return true;
}

function findLanding(m){
    var bx = Math.round(m.x / TS - m.ref[0]), by = Math.round(m.y / TS - m.ref[1]);
    var list = spiralOffsets(8);
    for(var i = 0; i < list.length; i++){
        var off = [bx + list[i][0], by + list[i][1]];
        if(fitsOnGrid(m, off)) return off;
    }
    return null;
}

/** parked = true: landed by an order / the park button, outside the build mode (see mergeTouching, exitBuildMode) */
function landMachine(m, parked){
    if(m.mode != "fly") return true;
    var off = findLanding(m);
    if(off == null){
        var under = Vars.world.tileWorld(m.x, m.y);
        say(under != null && under.floor().isDeep() ? "mb.msg.deepwater" : "mb.msg.noroom");
        return false;
    }
    var parts = m.parts.slice();
    var hull = m.hull;
    m.savedAng = m.ang;
    setAng(m, 0);

    var memberCover = {};
    parts.forEach(b => coverTiles(b).forEach(p => { memberCover[p] = true; }));
    var plans = [];
    withPocket(m, () => {
        parts.forEach(b => {
            plans.push({block: b.block, team: b.team, rot: blockRot(b), b: b, x: b.tile.x + off[0], y: b.tile.y + off[1], cfg: configToAbs(b)});
        });
        parts.forEach(b => b.pickedUp());
        parts.forEach(b => b.tile.setBlock(Blocks.air));
    }, true);

    var wasBusy = busy;
    busy = true;
    try{
        parts.forEach(b => b.afterPickedUp());
        plans.forEach(p => placeReal(p.block, p.team, p.rot, p.b, p.x, p.y));
        var mapPos = q => memberCover[q] ? Point2.pack(Point2.x(q) + off[0], Point2.y(q) + off[1]) : null;
        applyAllConfigs(plans, mapPos);
    }finally{
        busy = wasBusy;
    }
    m.mode = "land";
    m.parked = parked === true;
    m.cells = cellsOf(parts);
    m.pending = {};
    m.anchor = hull.pos();
    parts.forEach(b => {                  // engines are off while the machine stands on the grid
        var bs = bstates[b.id];
        // the glow is not reset: it fades out smoothly while the landed booster is drawn (see drawBooster)
        if(bs !== undefined){ bs.thrusting = false; bs.working = false; }
    });
    m.parts = []; m.hull = null; m.pocket = null; m.turrets = []; m.boosters = []; m.target = null;
    m.thrusting = false;
    m.vx = 0; m.vy = 0;
    reindexAll();
    var pos = machinePos(m);
    m.x = pos[0]; m.y = pos[1];
    ensureBody(m);                        // the body stays: a landed machine can be picked for take off in the RTS mode
    keepBody(m);
    saveDirty = true;
    try{
        if(isNetHost()){
            delete netSig[m.id];
            netFlushTiles();             // the blocks are on the ground first, then the picture of the machine goes
            netSend(true, "mb-gone", String(m.id));
        }
    }catch(eNet){ logErr("landMachine net", eNet); }
    return true;
}

// ---------------------------------------------------------------------------
//  damage: enemy bullets hit single blocks of a flying machine
// ---------------------------------------------------------------------------
function damagePart(m, part, amount){
    if(amount <= 0 || part.dead) return;
    var dm = Vars.state.rules.blockHealth(part.team);
    var eff = Mathf.zero(dm) ? part.health + 1 : amount / dm;
    if(part.health > eff + 1){
        part.damage(amount);
    }else{
        destroyPart(m, part, true);
        flyReconcile(m);
    }
}

function destroyPart(m, b, fx){
    if(b.dead) return;
    var boomReactor = isReactorBooster(b);
    var mid = m.id;
    try{
        var wp = toWorld(m, b.tile.drawx(), b.tile.drawy());
        b.set(wp[0], wp[1]);
        if(fx !== false) b.onDestroyed();
    }catch(e){
        logErr("destroyPart fx", e);
    }
    b.dead = true;
    withPocket(m, () => { b.tile.setBlock(Blocks.air); }, true);
    var i = m.parts.indexOf(b);
    if(i >= 0) m.parts.splice(i, 1);
    delete partIndex[b.id];
    delete bstates[b.id];
    if(m.hull === b) m.hull = null;
    if(boomReactor){
        try{
            reactorRule[b.id] = Vars.state.rules.reactorExplosions;
            reactorBoom(b);
        }catch(eR){ logErr("reactor booster boom", eR); }
    }
    // multiplayer: if nothing left to fly, drop registry + kill client ghost immediately
    var alive = 0;
    for(var ai = 0; ai < m.parts.length; ai++) if(!m.parts[ai].dead) alive++;
    if(alive == 0){
        try{ destroyMachine(m); }catch(eD){ logErr("destroyPart empty", eD); }
    }else if(boomReactor && isNetHost()){
        // structure changed a lot after reactor boom: force a fresh picture / clear stale ghost
        try{
            var sig = netSigOf(m);
            netSig[mid] = sig;
            netSend(true, "mb-struct", netEncodeStruct(m, sig));
        }catch(eN){ logErr("destroyPart net", eN); }
    }
}

/** after a block of a flying machine is gone: whatever was held only by it is destroyed too */
/** the group of blocks the machine stays with: the one holding its main hull; if that hull is gone,
 *  the biggest group that holds any hull. Everything else is detached. */
function splitGroups(comps, mainHull){
    var keep = null;
    if(mainHull != null){
        for(var i = 0; i < comps.length && keep == null; i++){
            if(comps[i].some(b => b === mainHull || (b.tile != null && mainHull.tile != null && b.pos() == mainHull.pos()))) keep = comps[i];
        }
    }
    if(keep == null){
        comps.forEach(c => {
            if(c.some(isHull) && (keep == null || c.length > keep.length)) keep = c;
        });
    }
    var good = [], bad = [];
    comps.forEach(c => { if(c === keep) good = good.concat(c); else bad = bad.concat(c); });
    return {good: good, bad: bad};
}

function flyReconcile(m){
    if(m.mode != "fly" || machines.indexOf(m) < 0) return;
    var alive = m.parts.filter(b => !b.dead);
    if(m.fall != null){                  // a falling machine stays whole until it hits the ground
        partsChanged(m);
        saveDirty = true;
        return;
    }
    var comps = components(alive);
    var sp = splitGroups(comps, m.hull != null && !m.hull.dead ? m.hull : null);
    var good = sp.good, bad = sp.bad;
    if(good.length == 0){
        if(alive.length > 0 && fallEnabled()) startFall(m, "hull");     // nothing holds the blocks together any more
        else destroyMachine(m);
        return;
    }
    bad.forEach(b => destroyPart(m, b, true));
    if(m.hull == null || m.hull.dead){
        m.hull = good.filter(isHull)[0];
    }
    partsChanged(m);
    saveDirty = true;
}

function destroyMachine(m){
    if(machines.indexOf(m) < 0 || m.dying) return;
    m.dying = true;
    var wasPossessed = poss != null && poss.m === m;
    var mid = m.id;
    if(m.mode == "fly"){
        m.parts.slice().forEach(b => destroyPart(m, b, true));
        m.parts = [];
    }
    dropMachine(m);
    if(wasPossessed) say("mb.msg.dead");
    try{
        if(isNetHost()){
            delete netSig[mid];
            netSend(true, "mb-gone", String(mid));
        }
    }catch(eNet){ logErr("destroyMachine net", eNet); }
}

// ---------------------------------------------------------------------------
//  falling: no thrust or no hull. The machine keeps its speed, spins, sinks (the shadow comes closer), burns and smokes,
//  then hits the ground (crashMachine): buildings under it take a huge damage, its own blocks are damaged, some are lost.
// ---------------------------------------------------------------------------
function startFall(m, why){
    if(m.fall != null || m.mode != "fly" || machines.indexOf(m) < 0) return;
    var cells = machineMass(m);
    var dur = Math.round(Math.min(FALL_MAX_TICKS, FALL_BASE_TICKS + cells * 0.8));
    // light machines tumble faster, heavy ones turn slowly; how much it turns depends on its speed (see fallStep)
    var spin = (Math.random() < 0.5 ? -1 : 1) * (0.3 + Math.random() * 0.6) * Mathf.clamp(40 / Math.max(1, cells), 0.4, 2.5);
    m.fall = {t: 0, dur: dur, spin: spin, h: 1, why: why};
    m.thrusting = false;
    m.noThrust = 0;
    m.arrived = false;
    for(var i = 0; i < m.boosters.length; i++){
        if(!m.boosters[i].dead){ var bs = bstate(m.boosters[i]); bs.thrusting = false; }
    }
    var fdr = driversOf(m);
    if(fdr.local || fdr.pls.length > 0 || Vars.headless) sayDrivers(fdr, why == "hull" ? "mb.msg.falling.hull" : "mb.msg.falling");
    saveDirty = true;
}

function fallEffects(m, f, p){
    if(Vars.headless || m.parts.length == 0) return;
    // smoke and fire from random blocks: a few per second at the start, a lot at the end
    var n = (0.08 + 0.5 * p) * Time.delta;
    while(n > 0){
        if(Math.random() > n) break;
        n -= 1;
        var b = m.parts[Math.floor(Math.random() * m.parts.length)];
        if(b == null || b.dead) continue;
        var w = toWorld(m, b.tile.drawx(), b.tile.drawy());
        try{
            if(Math.random() < 0.55) Fx.fuelburn.at(w[0], w[1]);
            else Fx.smoke.at(w[0], w[1]);
        }catch(e){ /* no picture then */ }
    }
}

function fallStep(m, delta){
    var f = m.fall;
    f.t += delta;
    var p = Math.min(1, f.t / f.dur);
    f.h = 1 - p * p;                                  // height over the ground: it falls faster and faster
    // the machine keeps its speed (the engines are off), slowly slowed by the air, and spins more and more
    var k = Math.exp(-delta * 0.015);
    m.vx *= k; m.vy *= k;
    m.x += m.vx * delta;
    m.y += m.vy * delta;
    var maxX = (Vars.world.width() - 1) * TS, maxY = (Vars.world.height() - 1) * TS;
    if(m.x < 0){ m.x = 0; m.vx = 0; }
    if(m.y < 0){ m.y = 0; m.vy = 0; }
    if(m.x > maxX){ m.x = maxX; m.vx = 0; }
    if(m.y > maxY){ m.y = maxY; m.vy = 0; }
    // a machine that hung in place falls straight down; the faster it was flying, the more it turns (and less as it slows down)
    var sp = Math.sqrt(m.vx * m.vx + m.vy * m.vy);
    var turn = Mathf.clamp(sp / 0.6, 0, 1);
    if(turn > 0.01) setAng(m, m.ang + f.spin * delta * turn * (0.4 + 1.2 * p));
    m.thrusting = false;
    try{ fallEffects(m, f, p); }catch(e){ logErr("fallEffects", e); }
    if(f.t >= f.dur){
        try{ crashMachine(m); }catch(e){
            logErr("crashMachine", e);
            m.fall = null;
            try{ destroyMachine(m); }catch(e2){ logErr("crash destroy", e2); }
        }
    }
}

/** what is under the machine: samples of the covered tiles in the real world */
function fallFootprint(m){
    var n = 0, deep = 0, blocked = 0, seen = {}, builds = [];
    m.parts.forEach(b => {
        if(b.dead) return;
        var sz = b.block.size;
        for(var ix = 0; ix < sz; ix++){
            for(var iy = 0; iy < sz; iy++){
                var ox = (ix - (sz - 1) / 2) * TS, oy = (iy - (sz - 1) / 2) * TS;
                var w = toWorld(m, b.tile.drawx() + ox, b.tile.drawy() + oy);
                var t = Vars.world.tileWorld(w[0], w[1]);
                n++;
                if(t == null) continue;
                try{ if(t.floor().isDeep()) deep++; }catch(e){ /* not deep */ }
                var bb = t.build;
                if(bb != null){
                    blocked++;
                    var key = bb.pos();
                    if(!seen[key]){ seen[key] = true; builds.push(bb); }
                }else if(t.solid()){
                    blocked++;
                }
            }
        }
    });
    return {n: n, deep: deep, blocked: blocked, builds: builds};
}

function crashFx(m, big){
    try{ netFx("crash", m.x, m.y, machineMass(m)); }catch(eN){ /* the clients miss the picture */ }
    if(Vars.headless) return;
    try{ Effect.shake(Math.min(18, 5 + machineMass(m) * 0.12), 30, m.x, m.y); }catch(e){ /* no shake */ }
    try{ Sounds.explosionbig.at(m.x, m.y); }catch(e){ /* no sound */ }
    var count = Math.min(24, 4 + Math.floor(m.parts.length / 3));
    for(var i = 0; i < count; i++){
        var b = m.parts[Math.floor(Math.random() * m.parts.length)];
        if(b == null || b.dead) continue;
        var w = toWorld(m, b.tile.drawx(), b.tile.drawy());
        try{
            if(i % 3 == 0) Fx.massiveExplosion.at(w[0], w[1]); else Fx.explosion.at(w[0], w[1]);
        }catch(e){ /* no picture */ }
    }
}

/** the hit: buildings under the machine, units under it, then the blocks of the machine itself */
function crashMachine(m){
    var cells = machineMass(m);
    var drv = driversOf(m);              // the players who drive it are told, also after they are released
    var fp = fallFootprint(m);
    m.fall = null;
    // sank: most of the machine is over deep water
    if(fp.n > 0 && fp.deep >= fp.n * 0.6){
        try{ Fx.splash.at(m.x, m.y); }catch(e){ /* no picture */ }
        m.parts.slice().forEach(b => destroyPart(m, b, false));
        destroyMachine(m);
        sayDrivers(drv, "mb.msg.sunk");
        return;
    }
    var onBuildings = fp.blocked > 0;
    crashFx(m, onBuildings);
    if(onBuildings){
        var gd = Math.min(FALL_GROUND_MAX, FALL_GROUND_DMG + FALL_GROUND_PER_CELL * cells);
        fp.builds.forEach(bb => { try{ bb.damage(gd); }catch(e){ logErr("crash building", e); } });
        try{
            var rr = m.radius;
            Groups.unit.intersect(m.x - rr, m.y - rr, rr * 2, rr * 2, cons(u => {
                try{ if(!u.isFlying() && u.type != driverType) u.damage(gd); }catch(e1){ /* one unit less */ }
            }));
        }catch(e){ logErr("crash units", e); }
    }
    // the blocks of the machine: on open ground part of them survives, on buildings most are lost; the hull is tougher
    var snapshot = m.parts.slice();
    snapshot.forEach(b => {
        if(b.dead) return;
        var f = onBuildings ? 0.8 + Math.random() * 1.2 : 0.25 + Math.random() * 1.1;
        if(isHull(b)) f *= 0.6;
        var hp = bMaxHealth(b) * f;
        if(b.health > hp){
            b.health = b.health - hp;
        }else{
            destroyPart(m, b, true);
        }
    });
    if(machines.indexOf(m) < 0) return;
    if(m.parts.length == 0){
        destroyMachine(m);
        sayDrivers(drv, "mb.msg.crashdead");
        return;
    }
    partsChanged(m);
    var hullAlive = m.hull != null && !m.hull.dead;
    if(hullAlive){
        flyReconcile(m);                          // what is not held by the hull any more is lost
        if(machines.indexOf(m) < 0) return;
        if(landMachine(m, true)){
            sayDrivers(drv, "mb.msg.crashed");
        }else{
            m.parts.slice().forEach(b => destroyPart(m, b, true));
            destroyMachine(m);
            sayDrivers(drv, "mb.msg.crashdead");
        }
        return;
    }
    // no hull: the blocks lie on the ground as ordinary buildings (wreckage), the machine is no more
    m.hull = m.parts[0];
    if(landMachine(m, true)){
        dropMachine(m);
        sayDrivers(drv, "mb.msg.wreck");
    }else{
        m.parts.slice().forEach(b => destroyPart(m, b, true));
        destroyMachine(m);
        sayDrivers(drv, "mb.msg.crashdead");
    }
}

function splashParts(m, x, y, radius, damage, skip){
    var l = toLocal(m, x, y);
    m.parts.slice().forEach(b => {
        if(b === skip || b.dead) return;
        var d = Mathf.dst(b.tile.drawx(), b.tile.drawy(), l[0], l[1]) - b.block.size * TS * 0.5;
        if(d > radius) return;
        var scaled = damage * (1 - 0.6 * Math.max(0, d) / radius);
        damagePart(m, b, Damage.applyArmor(scaled, b.block.armor));
    });
}

function partAtWorld(m, wx, wy){
    var l = toLocal(m, wx, wy);
    var t = m.pocket.get(Math.round(l[0] / TS), Math.round(l[1] / TS));
    if(t == null || t.build == null) return null;
    return t.build;
}

function unitDamageMul(team){
    try{ return Vars.state.rules.unitDamage(team); }catch(e){ return 1; }
}

// ---- wall properties of flying blocks ---------------------------------------------------------------
// The blocks of a flying machine live in a pocket world, so the normal game code that reacts to walls
// (bullet deflection, surge lightning, laser absorption) never sees them. It is redone here.

/** deflection (phase wall ...) and lightning (surge wall ...) of a wall hit by a bullet at (hx, hy).
 *  The wall settings are read straight from the block (no class check: only walls have these fields).
 *  returns true when the bullet was deflected: it flies away now and must do no damage */
function wallHitEffects(m, part, b, type, hx, hy){
    try{
        var blk = part.block;
        var cd = blk.chanceDeflect, lc = blk.lightningChance;
        var canDeflect = cd !== undefined && cd > 0;
        var canLightning = lc !== undefined && lc > 0;
        if(!canDeflect && !canLightning) return false;
        var bdmg = Number(b.damage);
        var wc = [part.tile.drawx(), part.tile.drawy()];        // wall centre in pocket units
        try{ part.hit = 1; }catch(e0){ /* no flash */ }
        if(canLightning && Mathf.chance(lc)){
            var wp = toWorld(m, wc[0], wc[1]);
            var ld = blk.lightningDamage < 0 ? bdmg : blk.lightningDamage;
            Lightning.create(part.team, blk.lightningColor, ld, wp[0], wp[1], b.rotation() + 180, blk.lightningLength);
        }
        if(canDeflect && type.reflectable !== false){
            var spd = Math.sqrt(b.vel.x * b.vel.x + b.vel.y * b.vel.y);
            if(spd > 0.1 && Mathf.chance(cd / bdmg)){
                b.set(hx, hy);                                  // the place where it touched the wall
                b.trns(-b.vel.x, -b.vel.y);                     // one step back, out of the wall
                // bounce in the frame of the machine, so that a turned machine reflects correctly
                var c = Mathf.cosDeg(m.ang), s = Mathf.sinDeg(m.ang);
                var lvx = b.vel.x * c + b.vel.y * s, lvy = -b.vel.x * s + b.vel.y * c;
                var lp = toLocal(m, b.x, b.y);
                if(Math.abs(lp[0] - wc[0]) > Math.abs(lp[1] - wc[1])) lvx = -lvx; else lvy = -lvy;
                b.vel.x = lvx * c - lvy * s;
                b.vel.y = lvx * s + lvy * c;
                b.owner = part;
                b.team = part.team;
                b.time = b.time + 1;
                return true;
            }
        }
    }catch(e){
        logErr("wallHitEffects", e);
    }
    return false;
}

/** 1 = instant laser (one hit), 2 = continuous beam (hits every damageInterval ticks), 0 = not a beam */
function beamKind(type){
    try{
        if(type instanceof Packages.mindustry.entities.bullet.LaserBulletType) return 1;
        if(type instanceof Packages.mindustry.entities.bullet.ContinuousBulletType) return 2;
    }catch(e){ /* class missing in this game version */ }
    return 0;
}

var beamState = {};        // bullet id -> {next: tick of the next hit, seen: last tick the bullet was seen, cut, cutTime}

/** distance from the start of a beam to the first block of the machine that absorbs lasers (plastanium wall), or -1.
 *  Measured every frame: the beam is DRAWN from the real world, where these blocks do not exist, so the drawing has to
 *  be told where to stop (see applyBeamCuts). */
function beamAbsorbDistance(m, b, type, length){
    if(type.laserAbsorb === false) return -1;
    var rot = b.rotation(), cs = Mathf.cosDeg(rot), sn = Mathf.sinDeg(rot);
    var t0 = Mathf.clamp((m.x - b.x) * cs + (m.y - b.y) * sn, 0, length);
    var reach = m.radius + 16;
    if(Mathf.dst2(b.x + cs * t0, b.y + sn * t0, m.x, m.y) > reach * reach) return -1;
    for(var d = Math.max(0, t0 - reach); d <= length; d += TS / 2){
        var part = partAtWorld(m, b.x + cs * d, b.y + sn * d);
        if(part == null || part.dead || part.team.id == b.team.id) continue;
        if(part.block.absorbLasers) return Math.max(6, d);
    }
    return -1;
}

/** a laser or beam of an enemy hits the blocks of a flying machine along its line;
 *  the line ends at the first block that absorbs lasers (plastanium wall) */
function scanBeam(m, b, type, kind){
    if(!type.collidesGround) return;
    var length = type.length;
    if(kind == 2){ try{ length = type.currentLength(b); }catch(e0){ /* keep the full length */ } }
    if(!(length > 0)) return;
    var st = beamState[b.id];
    if(st === undefined){ st = {next: Time.time, seen: Time.time, cut: -1, cutTime: -1}; beamState[b.id] = st; }
    st.seen = Time.time;

    // where the beam is stopped by a wall: kept up to date every frame, for the picture
    var cutNow = -1;
    try{ cutNow = beamAbsorbDistance(m, b, type, length); }catch(eCut){ logErr("beamAbsorbDistance", eCut); }
    if(cutNow > 0){
        if(st.cutTime !== Time.time || cutNow < st.cut) st.cut = cutNow;
        st.cutTime = Time.time;
        if(kind == 1){ try{ if(!(b.fdata <= cutNow)) b.fdata = cutNow; }catch(e1){ /* length is drawn from the real world */ } }
    }

    if(Time.time < st.next) return;
    var rot = b.rotation(), cs = Mathf.cosDeg(rot), sn = Mathf.sinDeg(rot);
    // is the machine anywhere near the line?
    var t0 = Mathf.clamp((m.x - b.x) * cs + (m.y - b.y) * sn, 0, length);
    var reach = m.radius + 16;
    if(Mathf.dst2(b.x + cs * t0, b.y + sn * t0, m.x, m.y) > reach * reach) return;
    // instant lasers hit once, a continuous beam again every damageInterval ticks
    st.next = kind == 1 ? Time.time + 1000000 : Time.time + (type.damageInterval > 0 ? type.damageInterval : 5);

    var absorb = type.laserAbsorb !== false;
    var cap = type.pierceCap > 0 ? type.pierceCap : 0;
    var hits = [], seen = {};
    for(var d = 0; d <= length; d += TS / 2){
        var part = partAtWorld(m, b.x + cs * d, b.y + sn * d);
        if(part == null || part.dead || part.team.id == b.team.id || seen[part.id]) continue;
        seen[part.id] = true;
        hits.push(part);
        if(absorb && part.block.absorbLasers){
            if(kind == 1){ try{ if(!(b.fdata <= d)) b.fdata = d; }catch(e1){ /* length is drawn from the real world */ } }
            break;
        }
        if(cap > 0 && hits.length >= cap) break;
    }
    for(var i = 0; i < hits.length; i++){
        var hp = hits[i];
        if(hp.dead || m.mode != "fly") continue;
        var dmg = b.damage * type.buildingDamageMultiplier * unitDamageMul(b.team);
        if(!type.pierceArmor) dmg = Damage.applyArmor(dmg, hp.block.armor);
        damagePart(m, hp, dmg);
    }
}

// A continuous beam (Vela ...) is DRAWN by the game from the real world: it measures where the first laser-absorbing
// block is and stops there. The plastanium walls of a flying machine are not in the real world, so the beam was drawn
// straight through them (the damage was right). While a frame is drawn, the `length` of the beam's type is therefore
// shortened to the wall (only when every beam of that type is stopped by a wall), and put back after the frame.
var beamCuts = [];         // [type, its real length] while the frame is drawn

function applyBeamCuts(){
    if(beamCuts.length > 0 || !Vars.state.isGame()) return;
    var infos = [];
    Groups.bullet.each(cons(b => {
        var type = b.type;
        if(beamKind(type) != 2) return;
        var rec = null;
        for(var i = 0; i < infos.length; i++){ if(infos[i].type.equals(type)){ rec = infos[i]; break; } }
        if(rec == null){ rec = {type: type, n: 0, cut: 0, min: 1e9}; infos.push(rec); }
        rec.n++;
        var st = beamState[b.id];
        if(st !== undefined && st.cut > 0 && Time.time - st.cutTime <= 2){
            rec.cut++;
            if(st.cut < rec.min) rec.min = st.cut;
        }
    }));
    for(var j = 0; j < infos.length; j++){
        var r = infos[j];
        if(r.cut == 0 || r.cut != r.n) continue;
        try{
            beamCuts.push([r.type, Number(r.type.length)]);
            r.type.length = r.min;
        }catch(e){
            logErr("applyBeamCuts", e);
        }
    }
}

function restoreBeamCuts(){
    for(var i = 0; i < beamCuts.length; i++){
        try{ beamCuts[i][0].length = beamCuts[i][1]; }catch(e){ logErr("restoreBeamCuts", e); }
    }
    beamCuts = [];
}

function pruneBeamState(){
    for(var k in beamState){
        if(beamState[k].seen < Time.time - 180) delete beamState[k];
    }
}

/** where the bullet was one tick ago (from its speed: lastX / lastY are not always up to date) */
function bulletPrev(b){
    var px = b.x, py = b.y;
    try{
        px = b.x - b.vel.x * Time.delta;
        py = b.y - b.vel.y * Time.delta;
    }catch(e){
        px = b.lastX; py = b.lastY;
    }
    if(!(Math.abs(px) < 1e7) || !(Math.abs(py) < 1e7)){ px = b.x; py = b.y; }
    return [px, py];
}

/** a "static" bullet: practically no speed of its own (the damage points of a lightning bolt ...).
 *  The bolts of Scepter & co. chain to the nearest enemy UNIT, and for a machine that is its body in the middle of the
 *  hull: the bolt then jumps through every block straight into the core / storage. */
function isStaticBullet(type){
    try{ return Number(type.speed) < 0.01; }catch(e){ return false; }
}

/** can a block of the machine be reached from outside, i.e. is there a straight line out of the machine along one of
 *  the four axes that no other block stands on? A block walled in on every side is covered. */
function partExposed(m, part){
    try{
        var c = [part.tile.drawx(), part.tile.drawy()];
        var half = part.block.size * TS / 2;
        var maxLen = (Math.max(m.pw || 0, m.ph || 0) + 2) * TS;
        for(var di = 0; di < 4; di++){
            var dx = DIRS[di][0], dy = DIRS[di][1];
            var blocked = false;
            for(var d = half + TS / 2; d <= maxLen && !blocked; d += TS){
                var t = m.pocket.get(Math.round((c[0] + dx * d) / TS), Math.round((c[1] + dy * d) / TS));
                if(t == null) break;                                   // left the pocket: the way is free
                if(t.build != null && t.build !== part && !t.build.dead) blocked = true;
            }
            if(!blocked) return true;
        }
        return false;
    }catch(e){
        logErr("partExposed", e);
        return true;
    }
}

/** a normal bullet (not a beam) against the blocks of one flying machine.
 *  The whole way the bullet flew this tick is checked, in order, from the old position to the new one,
 *  so a fast bullet cannot jump over a block: it stops at (or goes through, if it pierces) every block on its way.
 *  returns true when the bullet has been dealt with (no other machine needs to look at it) */
function scanProjectile(m, b, type){
    var prev = bulletPrev(b);
    var dx = b.x - prev[0], dy = b.y - prev[1];
    var dist = Math.sqrt(dx * dx + dy * dy);
    var splashR = type.splashDamageRadius > 0 ? type.splashDamageRadius : 0;
    var reach = m.radius + 16 + splashR + dist / 2;
    if(Mathf.dst2((b.x + prev[0]) / 2, (b.y + prev[1]) / 2, m.x, m.y) > reach * reach) return false;

    // area bullets that explode at the end of their flight (artillery ...)
    if(type.splashDamage > 0 && type.despawnHit && b.time + Time.delta >= b.lifetime){
        splashParts(m, b.x, b.y, type.splashDamageRadius, type.splashDamage * type.buildingDamageMultiplier * unitDamageMul(b.team), null);
        return true;
    }
    if(!type.collidesGround || !type.collidesTiles) return false;

    var through = type.pierceBuilding === true;            // only a building-piercing bullet flies on after a block
    var n = Math.min(80, Math.max(1, Math.ceil(dist / (TS / 3))));
    for(var k = 0; k <= n; k++){
        var hx = prev[0] + dx * k / n, hy = prev[1] + dy * k / n;
        var part = partAtWorld(m, hx, hy);
        if(part == null || part.dead || part.team.id == b.team.id) continue;
        if(through && b.collided.contains(part.id)) continue;
        if(!part.collide(b)) continue;
        if(isStaticBullet(type) && !partExposed(m, part)) continue;   // lightning does not pass through other blocks
        if(wallHitEffects(m, part, b, type, hx, hy)) return true;     // deflected by the wall: no damage

        var dmg = b.damage * type.buildingDamageMultiplier * unitDamageMul(b.team);
        if(!type.pierceArmor) dmg = Damage.applyArmor(dmg, part.block.armor);
        if(through){
            b.collided.add(part.id);
        }else{
            b.set(hx, hy);
            b.hit = true;
            b.remove();
        }
        try{ type.hit(b, hx, hy); }catch(e){ logErr("bullet hit", e); }
        damagePart(m, part, dmg);
        if(type.splashDamage > 0 && m.mode == "fly") splashParts(m, hx, hy, type.splashDamageRadius, type.splashDamage * type.buildingDamageMultiplier * unitDamageMul(b.team), part);
        if(!through || m.mode != "fly") return true;
        if(type.pierceCap > 0 && b.collided.size >= type.pierceCap){ b.remove(); return true; }
    }
    return false;
}

function scanBullets(){
    var fl = flyingMachines();
    if(fl.length == 0) return;
    var teams = {}, anyTeam = false;
    for(var ti = 0; ti < fl.length; ti++){ teams[fl[ti].team.id] = true; anyTeam = true; }
    Groups.bullet.each(cons(b => {
        var bt = b.team.id;
        var foe = false;                      // is there a flying machine of ANOTHER team at all?
        for(var tk in teams){ if(+tk !== bt){ foe = true; break; } }
        if(!foe) return;
        var type = b.type;
        var kind = beamKind(type);
        for(var i = 0; i < fl.length; i++){
            var m = fl[i];
            if(m.mode != "fly" || b.team.id == m.team.id) continue;
            if(kind != 0){
                try{ scanBeam(m, b, type, kind); }catch(e){ logErr("scanBeam", e); }
                continue;
            }
            try{
                if(scanProjectile(m, b, type)) break;
            }catch(e){
                logErr("scanProjectile", e);
            }
        }
    }));
    if(Time.time % 60 < Time.delta) pruneBeamState();
}

// ---------------------------------------------------------------------------
//  weapons: every turret of the machine works as one
// ---------------------------------------------------------------------------
var testFire = null;       // debug: [x, y] makes all turrets fire at a point
var testInput = null;      // debug: [ix, iy] replaces the player's movement input

function playerWantsFire(){
    var p = Vars.player;
    if(p == null) return false;
    return p.shooting && !Core.scene.hasMouse();
}

/** point to aim at so that a bullet fired from (sx, sy) meets a target at (tx, ty) moving with (tvx, tvy).
 *  The bullet flies with `speed` relative to the shooter, and the shooter itself moves with (svx, svy)
 *  (all speeds in world units per tick), so the whole thing is solved in the frame of the shooter. */
function leadPoint(sx, sy, svx, svy, tx, ty, tvx, tvy, speed){
    var rvx = tvx - svx, rvy = tvy - svy;            // target velocity as seen from the shooter
    var ox = tx - sx, oy = ty - sy;
    var a = rvx * rvx + rvy * rvy - speed * speed;
    var b = 2 * (ox * rvx + oy * rvy);
    var c = ox * ox + oy * oy;
    var time = 0;                                    // flight time of the bullet, ticks
    if(Math.abs(a) < 1e-6){
        if(Math.abs(b) > 1e-6) time = -c / b;
    }else{
        var disc = b * b - 4 * a * c;
        if(disc >= 0){
            var sq = Math.sqrt(disc);
            var t1 = (-b - sq) / (2 * a), t2 = (-b + sq) / (2 * a);
            var lo = Math.min(t1, t2), hi = Math.max(t1, t2);
            time = lo > 0 ? lo : hi;                 // the earliest meeting that lies in the future
        }
    }
    if(!(time > 0)) time = 0;                        // no solution (or NaN): aim straight at the target
    return [tx + rvx * time, ty + rvy * time];
}

/** speed of a target in world units per tick: units move, blocks stand still */
function targetVel(target){
    if(target instanceof Unit){
        try{ return [target.deltaX(), target.deltaY()]; }catch(e){ /* fall back to vel below */ }
        try{ return [target.vel.x, target.vel.y]; }catch(e2){ /* no velocity */ }
    }
    return [0, 0];
}

/** where turret t has to aim to hit the target. Bullets of the machine keep the machine's speed
 *  (see inheritMachineVelocity), so the lead is computed against the speed of the machine as well. */
function aimPoint(m, t, target){
    try{
        var bt = t.peekAmmo();
        if(bt != null && bt.speed > 0.01){
            var tv = targetVel(target);
            var keep = bt.keepVelocity !== false;    // beams and the like do not take the speed of the shooter
            return leadPoint(t.x, t.y, keep ? m.vx : 0, keep ? m.vy : 0, target.x, target.y, tv[0], tv[1], bt.speed);
        }
    }catch(e){ /* no lead */ }
    return [target.x, target.y];
}

/** positions of the parts must already be in real world coordinates */
function fireControl(m){
    var ts = m.turrets;
    if(ts.length == 0) return;
    var manual = null;
    if(testFire != null) manual = testFire;
    else if(poss != null && poss.m === m && !Vars.headless && playerWantsFire()) manual = [Vars.player.mouseX, Vars.player.mouseY];
    else{
        var rr = remoteOf(m);
        if(rr != null && rr.pl.shooting) manual = [rr.pl.mouseX, rr.pl.mouseY];   // shooting / mouseX / mouseY of a remote player are synced by the game
    }

    var target = null;
    if(manual == null){
        var maxR = 0, anyAir = false, anyGround = false;
        ts.forEach(t => {
            if(!t.hasAmmo()) return;
            var r = t.range();
            if(r > maxR) maxR = r;
            if(t.block.targetAir) anyAir = true;
            if(t.block.targetGround) anyGround = true;
        });
        var reach = maxR + m.radius;
        if(m.target != null && (m.target.dead || Units.invalidateTarget(m.target, m.team, m.x, m.y, reach))) m.target = null;
        m.targetTimer -= Time.delta;
        // an enemy the player ordered the machine to attack (RTS command mode) is shot first, as soon as it is in reach
        var ordered = null;
        if(maxR > 0){
            var cmd = commandAI(m);
            if(cmd != null){
                try{
                    var ct = cmd.attackTarget;
                    if(ct != null && !ct.dead && !Units.invalidateTarget(ct, m.team, m.x, m.y, reach)) ordered = ct;
                }catch(e){ logErr("ordered target", e); }
            }
        }
        if(ordered != null){
            m.target = ordered;
        }else if(maxR > 0 && (m.target == null || m.targetTimer <= 0)){
            m.targetTimer = 12;
            var cand = Units.closestTarget(m.team, m.x, m.y, reach, boolf(u => u.checkTarget(anyAir, anyGround)), boolf(b => anyGround));
            m.target = cand;
        }
        if(maxR == 0) m.target = null;
        target = m.target;
    }
    var hr = (frontDeg(m) + m.ang) * Mathf.degRad;     // idle guns look where the front of the machine looks
    var fx = m.x + Math.cos(hr) * 100, fy = m.y + Math.sin(hr) * 100;
    for(var i = 0; i < ts.length; i++){
        var t = ts[i];
        var ax = fx, ay = fy, shoot = 0;
        if(manual != null){
            ax = manual[0]; ay = manual[1]; shoot = 1;
        }else if(target != null){
            var ap = aimPoint(m, t, target);
            ax = ap[0]; ay = ap[1];
            var air = (target instanceof Unit) && target.isFlying();
            var typeOk = air ? t.block.targetAir : t.block.targetGround;
            var inRange = Mathf.dst(t.x, t.y, target.x, target.y) <= t.range() + (target instanceof Unit ? target.hitSize / 2 : 0);
            shoot = (typeOk && inRange && t.hasAmmo()) ? 1 : 0;
        }
        t.control(LAccess.shoot, ax / TS, ay / TS, shoot, 0);
    }
}

// ---------------------------------------------------------------------------
//  the bullets of the machine's guns keep the speed of the whole machine
// ---------------------------------------------------------------------------
// A unit's bullets take the unit's velocity (BulletType.keepVelocity, on by default). Bullets of a turret do not:
// their owner is a block, not a unit. The guns of a flying machine are blocks, so the machine does it for them:
// every new bullet fired by a block of a flying machine gets the velocity of the machine added to its own.
var inheritedBullets = new java.util.IdentityHashMap();    // bullets that already got the speed of their machine

/** the flying machine whose block fired the bullet; null for any other bullet */
function machineOfBullet(b){
    var o = b.owner;
    if(o == null || !(o instanceof Building)) return null;
    var m = partIndex[o.id];
    return (m === undefined || m.mode != "fly") ? null : m;
}

/** Called twice per frame: right after the guns were updated (bullets that were fired this very tick get the speed before
 *  their first step) and after the game update (shots with a delay, fragments and the like are created later in the frame).
 *  Every bullet is handled once: `inheritedBullets` remembers the ones that are done. */
function inheritMachineVelocity(){
    var armed = false, fl = flyingMachines();
    for(var i = 0; i < fl.length; i++){
        if(fl[i].turrets.length > 0){ armed = true; break; }
    }
    if(!armed){
        if(!inheritedBullets.isEmpty()) inheritedBullets = new java.util.IdentityHashMap();
        return;
    }
    var fresh = Time.delta * 2 + 1;                  // a bullet is "new" for a couple of ticks after it was fired
    var done = new java.util.IdentityHashMap();      // rebuilt every time: bullets that are gone drop out of the list
    Groups.bullet.each(cons(b => {
        try{
            var m = machineOfBullet(b);
            if(m == null) return;
            done.put(b, true);
            if(inheritedBullets.containsKey(b)) return;
            if(b.time > fresh) return;               // an old bullet (fired before the machine took off ...): leave it alone
            // beams, lightning ...: as for units, they do not take the speed (keepVelocity is off for them);
            // a bullet that practically stands still (a beam, its direction is the direction of its tiny velocity) is skipped too
            if(b.type.keepVelocity === false || b.type.speed <= 0.01) return;
            if(isDriverBolt(b)) return;              // the bolt of a mass driver flies to its target by itself (see mdSteerBolts)
            if(m.vx != 0 || m.vy != 0) b.vel.add(m.vx, m.vy);
        }catch(e){
            logErr("inheritMachineVelocity", e);
        }
    }));
    inheritedBullets = done;
}

// ---------------------------------------------------------------------------
//  a flying machine: movement, collisions, logic of its blocks
// ---------------------------------------------------------------------------
var lastMsg = -1000;
var padX = 0, padY = 0;     // (old) per-frame pad input
var joyX = 0, joyY = 0, joyOn = false;   // analog touch stick: -1..1 on both axes, kept while the finger is down

function readInput(){
    if(testInput != null) return testInput;
    var ix = 0, iy = 0;
    if(!Vars.headless && Core.input != null && !Core.scene.hasKeyboard() && !Core.scene.hasDialog()){
        ix = Core.input.axis(Binding.moveX);
        iy = Core.input.axis(Binding.moveY);
    }
    return [Mathf.clamp(ix + padX + joyX, -1, 1), Mathf.clamp(iy + padY + joyY, -1, 1)];
}

function turnRate(speed){ // degrees per second (speed in tiles/s): light machines turn faster
    return Mathf.clamp(40 + speed * 45, 40, 270);
}

/** Steers a machine in the direction (ux, uy) (a unit vector) with `power` (0..1) of its top speed and returns the speed
 *  [vx, vy] it aims at, in world units per tick. With "turn towards the movement" on, the front (green arrow) turns to
 *  the direction first and the machine goes where its front looks. With `noTurn` the machine does not turn at all: it
 *  just slides in the direction (used for the last few tiles before a goal, see flyToGoal). */
function thrustToward(m, ux, uy, power, tiles, spd, delta, noTurn){
    m.thrusting = true;
    if(autoTurn() && noTurn !== true){
        var want = Math.atan2(uy, ux) * 180 / Math.PI;
        var diff = signedDiff(want, frontDeg(m) + m.ang);      // the front (green arrow) leads
        var maxTurn = turnRate(tiles) / 60 * delta;
        var turn = Math.abs(diff) <= maxTurn ? diff : (diff > 0 ? maxTurn : -maxTurn);
        setAng(m, m.ang + turn);
        var f = Math.max(0, Math.cos((diff - turn) * Math.PI / 180));
        var hr = (frontDeg(m) + m.ang) * Math.PI / 180;
        return [Math.cos(hr) * spd * f * power, Math.sin(hr) * spd * f * power];
    }
    return [ux * spd * power, uy * spd * power];
}

// ---- orders of the RTS command mode (the machines are commanded like any other unit) ----------------------
// The body unit of a machine has the standard CommandAI of the game. It only stores the orders (a point to go to, an
// enemy to attack, a queue of waypoints, the place in the formation of a group); the body itself cannot move
// (speed 0), so the machine moves for it: the machine flies to the point the AI wants its body at.
var CommandAIClass = null;
try{ CommandAIClass = Packages.mindustry.ai.types.CommandAI; }catch(e){ CommandAIClass = null; }

/** the RTS controller of the body of machine m, null while a player drives the machine (or there is no body) */
function commandAI(m){
    var d = m.body;
    if(d == null) return null;
    try{
        if(!d.isValid()) return null;
        var c = d.controller();
        if(c == null) return null;
        if(CommandAIClass != null) return (c instanceof CommandAIClass) ? c : null;
        return c.targetPos !== undefined ? c : null;
    }catch(e){
        logErr("commandAI", e);
        return null;
    }
}

/** how far from an enemy the machine stops: inside the reach of its guns (80% of the shortest range of the armed
 *  turrets, so every gun reaches), a bit more than its own size when it has none */
function engageDistance(m, target){
    var r = 0;
    for(var i = 0; i < m.turrets.length; i++){
        var t = m.turrets[i];
        if(t.dead || !t.hasAmmo()) continue;
        var tr = t.range();
        if(r == 0 || tr < r) r = tr;
    }
    var size = 0;
    try{ if(target instanceof Unit) size = target.hitSize / 2; else if(target instanceof Building) size = target.block.size * TS / 2; }catch(e){ /* no size */ }
    if(r > 0) return Math.max(m.radius * 0.5, r * 0.8 - size * 0.5);
    return m.radius + size + 8;
}

/** where the orders want the machine: {x, y, stop, target} (stop = distance at which it stays), null = no order */
function commandGoal(m, ai){
    var at = null;
    try{ at = ai.attackTarget; }catch(e){ at = null; }
    if(at != null){
        try{
            if(at.isValid && !at.isValid()) at = null;
        }catch(e2){ at = null; }
    }
    if(at != null){
        return {x: at.getX(), y: at.getY(), stop: engageDistance(m, at), target: at};
    }
    var tp = ai.targetPos;
    if(tp == null) return null;
    var x = tp.x, y = tp.y;
    // place in the formation of a group that was sent to the same point
    try{
        var g = ai.group;
        if(g !== undefined && g != null && g.valid && g.positions != null && ai.groupIndex >= 0 && ai.groupIndex * 2 + 1 < g.positions.length){
            x += g.positions[ai.groupIndex * 2];
            y += g.positions[ai.groupIndex * 2 + 1];
        }
    }catch(e3){ /* no formation */ }
    return {x: x, y: y, stop: 0, target: null};
}

// ---- arriving at a goal ---------------------------------------------------------------------------------------
// A machine that flies to a point / vein / enemy used to chase the goal with an under-damped speed control: it shot past
// the goal, turned its front round by 180 degrees to come back, shot past again ... and the goal of the ship autopilot
// even moves with the angle of the machine (the drill sits off-centre), so the machine circled around the vein.
// Now: (1) the approach is critically damped, so nothing is overshot, (2) near the goal the machine stops turning and only
// slides on, (3) at the goal it STOPS: no thrust, no turning, until something pushes it away from the goal.
var ARRIVE_DIST = 2;          // world units from the goal point: the machine has arrived
var LEAVE_DIST = 7;           // it flies again only when pushed this far away (hysteresis: no flicker on the edge)
var ARRIVE_DIST_ENEMY = 6;    // the goal is an enemy: close enough (it moves, so the stop is looser)
var LEAVE_DIST_ENEMY = 24;
var APPROACH_GAIN = 0.025;    // speed aimed at = distance * this (per tick); critical damping with the engine lag below
var HEADING_FREEZE = 12;      // closer than this (+ 1.5 x the offset of the drill) the machine stops turning

/** Flies machine m to goal {x, y, stop, target, lever} and returns the speed [vx, vy] it aims at (world units per tick).
 *  Keeps m.arrived / m.headFrozen. */
function flyToGoal(m, goal, tiles, spd, delta){
    var gx = goal.x - m.x, gy = goal.y - m.y;
    var dist = Math.sqrt(gx * gx + gy * gy);
    var left = dist - goal.stop;                       // what is left to fly
    var enemy = goal.target != null;
    var arriveD = enemy ? ARRIVE_DIST_ENEMY : ARRIVE_DIST;
    var leaveD = enemy ? LEAVE_DIST_ENEMY : LEAVE_DIST;
    if(m.arrived === true){
        if(left > leaveD) m.arrived = false;
    }else if(left <= arriveD){
        m.arrived = true;
    }
    if(m.arrived === true){
        m.headFrozen = false;
        if(enemy){
            // an enemy keeps moving: stay and face it (only the nose turns, the machine does not drift)
            if(autoTurn() && dist > 4){
                var wantA = Math.atan2(gy, gx) * 180 / Math.PI;
                var dA = signedDiff(wantA, frontDeg(m) + m.ang);
                var mt = turnRate(tiles) / 60 * delta;
                setAng(m, m.ang + (Math.abs(dA) <= mt ? dA : (dA > 0 ? mt : -mt)));
            }
        }else{
            m.vx = 0; m.vy = 0;                        // a vein / a point: dead stop, no thrust, no turning
        }
        return [0, 0];
    }
    // not there yet: near the goal the heading is frozen (the machine slides on without turning)
    var freezeD = HEADING_FREEZE + (goal.lever || 0) * 1.5;
    if(m.headFrozen === true){
        if(left > freezeD * 1.6) m.headFrozen = false;
    }else if(left < freezeD){
        m.headFrozen = true;
    }
    // the speed shrinks with the distance, so the machine arrives smoothly and does not shoot past the goal
    var power = Math.min(1, left * APPROACH_GAIN / spd);
    if(power <= 0.001) return [0, 0];
    return thrustToward(m, gx / dist, gy / dist, power, tiles, spd, delta, m.headFrozen === true);
}

/** over the planned spot: the machine turns to the angle the plan was made for, so that its drills lie on the ore as counted */
function shipAlign(m, tiles, delta){
    var g = m.shipGoal;
    if(g == null || g.ang === undefined) return;
    var d = signedDiff(g.ang, m.ang);
    if(Math.abs(d) < 0.5) return;
    var step = turnRate(tiles) / 60 * delta;
    setAng(m, m.ang + (Math.abs(d) <= step ? d : (d > 0 ? step : -step)));
}

function moveFlying(m, delta){
    var st = m.stats || machineStats(m);
    var local = poss != null && poss.m === m;
    var rec = remoteOf(m);
    var possessed = local || rec != null;
    // the RTS orders of the machine (none while a player drives it)
    var orderAI = possessed ? null : commandAI(m);
    var orderGoal = orderAI == null ? null : commandGoal(m, orderAI);
    shipWatchCommands(m, possessed, orderGoal != null);   // a command carried out: the distances to the veins are measured again
    shipFastTick(m);                         // a liquid goes into the store at once, not only at the checks
    shipTick(m, delta);                      // the ship control blocks: which ore / liquid the machine has to fetch
    var tiles = flightSpeed(m);              // tiles/s the boosters give right now (power / fuel are taken into account)
    var spd = tiles * TS / 60;               // world units per tick
    var tvx = 0, tvy = 0;
    m.thrusting = false;                     // true only while the machine is being driven; the boosters read it
    if(possessed){
        m.arrived = false;
        m.headFrozen = false;
        // Q / E turn the machine by hand (any angle)
        if(local && !Vars.headless && Core.input != null && !Core.scene.hasKeyboard() && !Core.scene.hasDialog()){
            var spin = (Core.input.keyDown(KeyCode.q) ? 1 : 0) - (Core.input.keyDown(KeyCode.e) ? 1 : 0);
            if(spin != 0) setAng(m, m.ang + spin * turnRate(tiles) / 60 * delta);
        }else if(!local && rec != null && remoteFresh(rec) && rec.spin != 0){
            setAng(m, m.ang + rec.spin * turnRate(tiles) / 60 * delta);
        }
        var inp = local ? readInput() : remoteInput(rec);
        var ix = inp[0], iy = inp[1];
        if(ix != 0 || iy != 0){
            if(st.boosters == 0){
                if(Time.globalTime - lastMsg > 120){ lastMsg = Time.globalTime; ctxPl = local ? null : rec.pl; say("mb.msg.nowheels"); ctxPl = null; }
            }else{
                if(tiles <= 0.001 && Time.globalTime - lastMsg > 120){ lastMsg = Time.globalTime; ctxPl = local ? null : rec.pl; say("mb.msg.nothrust"); ctxPl = null; }
                var len = Math.sqrt(ix * ix + iy * iy);
                var tv = thrustToward(m, ix / len, iy / len, Math.min(1, len), tiles, spd, delta);   // analog: a half-pushed stick = half speed
                tvx = tv[0]; tvy = tv[1];
            }
        }
    }else if(st.boosters > 0 && tiles > 0.001){
        // nobody drives it: it follows the orders given in the RTS command mode (single machines and whole groups);
        // without an order it follows the autopilot of its ship control blocks (see shipTick)
        var goal = orderGoal, atVein = false;
        if(goal == null) goal = shipHomeGoal(m);
        if(goal == null) goal = shipSupplyGoal(m);
        if(goal == null){
            goal = shipGoal(m);
            atVein = goal != null;
        }
        if(goal != null){
            var tv2 = flyToGoal(m, goal, tiles, spd, delta);   // arrives smoothly, stops at the goal, does not circle
            tvx = tv2[0]; tvy = tv2[1];
            // go round the other machines in good time (their paths cross: out of the core and back to it), and a soft push
            // away from those that are too close, so supply fleets do not pin each other on the core
            var sep = shipSeparation(m, spd);
            var gLeft = Math.sqrt(Math.pow(goal.x - m.x, 2) + Math.pow(goal.y - m.y, 2)) - (goal.stop || 0);
            var av = shipAvoid(m, tvx, tvy, spd, gLeft);
            tvx = tvx * av[2] + av[0] + sep[0];
            tvy = tvy * av[2] + av[1] + sep[1];
            var tl = Math.sqrt(tvx * tvx + tvy * tvy);
            if(tl > spd){ tvx *= spd / tl; tvy *= spd / tl; }
            if(atVein && m.arrived === true) shipAlign(m, tiles, delta);
        }else{
            m.arrived = false;
            m.headFrozen = false;
        }
    }else{
        m.arrived = false;
        m.headFrozen = false;
    }
    var k = 1 - Math.exp(-delta * 0.12);
    m.vx += (tvx - m.vx) * k;
    m.vy += (tvy - m.vy) * k;
    m.x += m.vx * delta;
    m.y += m.vy * delta;
    // stay on the map
    var maxX = (Vars.world.width() - 1) * TS, maxY = (Vars.world.height() - 1) * TS;
    if(m.x < 0){ m.x = 0; m.vx = 0; }
    if(m.y < 0){ m.y = 0; m.vy = 0; }
    if(m.x > maxX){ m.x = maxX; m.vx = 0; }
    if(m.y > maxY){ m.y = maxY; m.vy = 0; }
}

// ---- collisions between machines: mass, momentum and energy -------------------------------------------------
// Every occupied cell weighs 1, so a machine of 100 cells is 100 times heavier than a single block. Two machines that
// touch exchange momentum like billiard balls (mass x velocity is conserved, a part of the kinetic energy is lost,
// see COLLIDE_RESTITUTION) and are pushed apart in inverse proportion to their mass: the heavier one gives way less.
// Example: 100 cells at 1 tile/s carry the momentum 100, a single cell at 10 tiles/s only 10 - the big one does not
// stop, the small one is thrown back. (Equal kinetic energy, 50 = 50, but the mass decides who pushes whom.)
// The engines keep working while the machines touch, so a machine that is driven into a heavier one cannot move it.
var COLLIDE_RESTITUTION = 0.25;     // share of the approach speed that comes back: 0 = stick together, 1 = perfectly elastic
var IMPACT_FX_SPEED = 0.45;         // approach speed (world units per tick) above which a hit is visible (sparks)
var impactStamp = {};               // pair key -> game time of the last spark, so a long push does not spam effects

/** weight of a machine: its occupied cells */
function machineMass(m){
    var c = m.stats != null ? m.stats.cells : 0;
    return Math.max(1, c > 0 ? c : m.parts.length);
}

/** kinetic energy of a machine, 1/2 m v^2 (cells x (world units per tick)^2) */
function machineEnergy(m){
    return 0.5 * machineMass(m) * (m.vx * m.vx + m.vy * m.vy);
}

/** momentum of a machine, m v (cells x world units per tick) */
function machineMomentum(m){
    var mass = machineMass(m);
    return [mass * m.vx, mass * m.vy];
}

/** world centre and radius of every block of a flying machine */
function worldCircles(m){
    var n = m.parts.length, xs = new Array(n), ys = new Array(n), rs = new Array(n);
    var c = Mathf.cosDeg(m.ang), s = Mathf.sinDeg(m.ang);
    var rx = m.ref[0] * TS, ry = m.ref[1] * TS;
    for(var i = 0; i < n; i++){
        var p = m.parts[i];
        var lx = p.tile.drawx() - rx, ly = p.tile.drawy() - ry;
        xs[i] = m.x + lx * c - ly * s;
        ys[i] = m.y + lx * s + ly * c;
        rs[i] = p.block.size * TS * 0.5;
    }
    return {xs: xs, ys: ys, rs: rs, n: n};
}

/** the blocks of circles `c` that can touch a machine centred at (mx, my) with radius mr */
function nearCircles(c, mx, my, mr){
    var out = [];
    for(var i = 0; i < c.n; i++){
        var reach = mr + c.rs[i];
        var dx = c.xs[i] - mx, dy = c.ys[i] - my;
        if(dx * dx + dy * dy <= reach * reach) out.push(i);
    }
    return out;
}

/** two flying machines: finds how they overlap and resolves it with masses (see above); true when they touched */
function collidePair(a, b, ca, cb){
    var la = nearCircles(ca, b.x, b.y, b.radius);
    var lb = nearCircles(cb, a.x, a.y, a.radius);
    if(la.length == 0 || lb.length == 0) return false;

    // contact: the normal is the average of the normals of all overlapping block pairs, weighted by the overlap
    var sumNx = 0, sumNy = 0, sumW = 0, cx = 0, cy = 0;
    var maxPen = 0, bestNx = 1, bestNy = 0;
    for(var ii = 0; ii < la.length; ii++){
        var i = la[ii];
        var ax = ca.xs[i], ay = ca.ys[i], ar = ca.rs[i];
        for(var jj = 0; jj < lb.length; jj++){
            var j = lb[jj];
            var dx = cb.xs[j] - ax, dy = cb.ys[j] - ay;
            var rr = ar + cb.rs[j];
            var d2 = dx * dx + dy * dy;
            if(d2 >= rr * rr) continue;
            var d = Math.sqrt(d2);
            var nx, ny;
            if(d > 0.001){ nx = dx / d; ny = dy / d; }
            else{
                var ex = b.x - a.x, ey = b.y - a.y, el = Math.sqrt(ex * ex + ey * ey);
                if(el > 0.001){ nx = ex / el; ny = ey / el; }else{ nx = 1; ny = 0; }
            }
            var pen = rr - d;
            sumNx += nx * pen; sumNy += ny * pen; sumW += pen;
            cx += (ax + cb.xs[j]) / 2 * pen; cy += (ay + cb.ys[j]) / 2 * pen;
            if(pen > maxPen){ maxPen = pen; bestNx = nx; bestNy = ny; }
        }
    }
    if(maxPen <= 0) return false;
    var nl = Math.sqrt(sumNx * sumNx + sumNy * sumNy);
    var gx = bestNx, gy = bestNy;
    if(nl > 0.25 * sumW){ gx = sumNx / nl; gy = sumNy / nl; }     // opposite normals cancel out: then the deepest pair decides

    var ma = machineMass(a), mb = machineMass(b);
    var ia = 1 / ma, ib = 1 / mb, isum = ia + ib;

    // 1. push apart: the lighter machine moves more (shares are inverse to the masses)
    a.x -= gx * maxPen * (ia / isum); a.y -= gy * maxPen * (ia / isum);
    b.x += gx * maxPen * (ib / isum); b.y += gy * maxPen * (ib / isum);

    // 2. momentum is exchanged along the contact normal; a part of the energy is lost (restitution)
    var rel = (b.vx - a.vx) * gx + (b.vy - a.vy) * gy;           // < 0: they approach each other
    if(rel < 0){
        var jImp = -(1 + COLLIDE_RESTITUTION) * rel / isum;      // impulse, equal and opposite for both
        a.vx -= jImp * ia * gx; a.vy -= jImp * ia * gy;
        b.vx += jImp * ib * gx; b.vy += jImp * ib * gy;
        if(-rel > IMPACT_FX_SPEED && !Vars.headless) impactSparks(a, b, cx / sumW, cy / sumW, -rel);
    }
    return true;
}

function impactSparks(a, b, x, y, speed){
    try{
        var key = a.id < b.id ? a.id + ":" + b.id : b.id + ":" + a.id;
        var last = impactStamp[key];
        if(last !== undefined && Time.globalTime >= last && Time.globalTime - last < 20) return;
        impactStamp[key] = Time.globalTime;
        Fx.hitBulletSmall.at(x, y);
    }catch(e){
        logErr("impactSparks", e);
    }
}

/** machines are solid for other machines only */
function collideMachines(){
    var fl = flyingMachines();
    if(fl.length < 2) return;
    var circles = {};
    var get = m => {
        var c = circles[m.id];
        if(c === undefined){ c = worldCircles(m); circles[m.id] = c; }
        return c;
    };
    for(var i = 0; i < fl.length; i++){
        for(var j = i + 1; j < fl.length; j++){
            var a = fl[i], b = fl[j];
            if(a.parts.length == 0 || b.parts.length == 0) continue;
            var reach = a.radius + b.radius;
            if(Mathf.dst2(a.x, a.y, b.x, b.y) > reach * reach) continue;
            var ax0 = a.x, ay0 = a.y, bx0 = b.x, by0 = b.y;
            if(collidePair(a, b, get(a), get(b))){
                // the machines were moved: their cached block positions are stale for the next pair
                if(a.x != ax0 || a.y != ay0) delete circles[a.id];
                if(b.x != bx0 || b.y != by0) delete circles[b.id];
            }
        }
    }
}

function fallEnabled(){
    return Core.settings == null || Core.settings.getBool("mb-fall", true);
}

function flyStep(m, delta){
    if(m.mode != "fly") return;
    if(m.fall != null){
        fallStep(m, delta);
        return;
    }
    if(m.parts.length == 0 || m.hull == null || m.hull.dead){
        flyReconcile(m);                 // without a hull the blocks fall (or, if none is left, the machine is gone)
        return;
    }
    // no thrust at all (every engine destroyed, or no fuel / power for the ones that are left): the machine falls
    if(m.stats == null){ try{ partsChanged(m); }catch(e){ logErr("stats", e); } }     // thrust is measured from the stats
    if(fallEnabled() && flightSpeed(m) <= 0.001){
        m.noThrust = (m.noThrust || 0) + delta;
        if(m.noThrust >= FALL_NOTHRUST_TICKS){
            startFall(m, "thrust");
            return;
        }
    }else{
        m.noThrust = 0;
    }
    moveFlying(m, delta);
}

// ---- healing blocks in flight -------------------------------------------------------------------------
// Mender / Mend Projector / Regen Projector look for the blocks to heal in the game's building index, and the blocks of
// a flying machine are not in it (they live in the pocket world). So their own logic runs (power, silicon, timers) but
// heals nothing. The healing is redone here, on the blocks of the machine.
var MendClass = null, RegenClass = null;
try{ MendClass = Packages.mindustry.world.blocks.defense.MendProjector; }catch(e){ MendClass = null; }
try{ RegenClass = Packages.mindustry.world.blocks.defense.RegenProjector; }catch(e){ RegenClass = null; }

/** true when the block's class, or one of its parents, has this simple name (works when a game version moves a class to another package) */
function classChainHas(obj, simpleName){
    try{
        var c = obj.getClass();
        while(c != null){
            if(String(c.getSimpleName()) == simpleName) return true;
            c = c.getSuperclass();
        }
    }catch(e){ /* not a Java object */ }
    return false;
}
function isMender(p){
    try{ if(MendClass != null && p.block instanceof MendClass) return true; }catch(e){ /* class not found: use the name */ }
    return classChainHas(p.block, "MendProjector");
}
function isRegenProjector(p){
    try{ if(RegenClass != null && p.block instanceof RegenClass) return true; }catch(e){ /* class not found: use the name */ }
    return classChainHas(p.block, "RegenProjector");
}
function isOverdrive(p){
    return classChainHas(p.block, "OverdriveProjector");
}
function isForceProjector(p){
    return classChainHas(p.block, "ForceProjector");
}

var odState = {};          // part id -> {t: charge timer}

/** Overdrive Projector / Dome: the original gives the boost to the blocks its game index finds in range, and the index does
 *  not know the blocks of a flying machine. Same timer and the same boost, applied to the blocks of the machine. */
function overdriveBlock(m, p, delta){
    if(!isOverdrive(p)) return;
    var blk = p.block;
    var st = odState[p.id];
    if(st === undefined){ st = {t: 0}; odState[p.id] = st; }
    var eff = numOr(p.efficiency, 0);
    var heat = numOr(p.heat, eff > 0 ? 1 : 0);
    var reload = numOr(blk.reload, 60);
    st.t += heat * delta;
    if(st.t < reload) return;
    st.t = 0;
    if(eff <= 0) return;
    var phase = numOr(p.phaseHeat, 0);
    var range = numOr(blk.range, 80) + phase * numOr(blk.phaseRangeBoost, 20);
    var boost;
    try{ boost = Number(p.realBoost()); }catch(e){ boost = NaN; }
    if(isNaN(boost)) boost = (numOr(blk.speedBoost, 1.5) + phase * numOr(blk.speedBoostPhase, 0.75)) * eff;
    var c = [p.tile.drawx(), p.tile.drawy()];
    var parts = m.parts.slice();
    for(var i = 0; i < parts.length; i++){
        var o = parts[i];
        if(o.dead || o === p || o.block.canOverdrive === false) continue;
        var d = Mathf.dst(o.tile.drawx(), o.tile.drawy(), c[0], c[1]);
        if(d > range + o.block.size * TS / 2) continue;
        try{ o.applyBoost(boost, reload + 1); }catch(e2){ logErr("applyBoost", e2); }
    }
}
function numOr(v, def){
    var n = Number(v);
    return isNaN(n) ? def : n;
}

/** max health of a block. In some game versions "maxHealth" is a field of the building and a method too, and Rhino hands out the field */
function bMaxHealth(o){
    var v = NaN;
    try{ v = typeof o.maxHealth === "function" ? Number(o.maxHealth()) : Number(o.maxHealth); }catch(e){ v = NaN; }
    if(isNaN(v) || v <= 0) v = numOr(o.block.health, 100);
    return v;
}
function bDamaged(o){
    try{
        if(typeof o.damaged === "function") return !!o.damaged();
    }catch(e){ /* use the numbers */ }
    return numOr(o.health, 0) < bMaxHealth(o) - 0.001;
}
function bHeal(o, amount){
    try{
        if(typeof o.heal === "function"){ o.heal(amount); return; }
    }catch(e){ /* fall through to the field */ }
    o.health = Math.min(bMaxHealth(o), numOr(o.health, 0) + amount);
}

/** heals every damaged block of the machine within `range` (pocket units, measured from the centre of p) */
function healAround(m, p, range, amountOf){
    var c = [p.tile.drawx(), p.tile.drawy()];
    var parts = m.parts.slice();
    var count = 0;
    for(var i = 0; i < parts.length; i++){
        var o = parts[i];
        if(o.dead || !bDamaged(o)) continue;
        try{ if(o.isHealSuppressed()) continue; }catch(e0){ /* older versions have no suppression */ }
        var d = Mathf.dst(o.tile.drawx(), o.tile.drawy(), c[0], c[1]);
        if(d > range + o.block.size * TS / 2) continue;
        bHeal(o, amountOf(o));
        count++;
        try{ o.recentlyHealed(); }catch(e1){ /* not in every version */ }
        try{
            var wp = toWorld(m, o.tile.drawx(), o.tile.drawy());
            Fx.healBlockFull.at(wp[0], wp[1], o.block.size, p.block.baseColor, o.block);
        }catch(e2){ /* effect only */ }
    }
    return count;
}

var healState = {};        // part id -> {t: ticks since the last pulse, log: tick of the last diagnostic line}

function healLog(m, p, what, extra){
    var st = healState[p.id];
    if(st === undefined || Time.time - st.log < 600) return;
    st.log = Time.time;
    Log.info("[mb] " + what + " " + p.block.name + " eff=" + numOr(p.efficiency, -1).toFixed(2) + " " + extra);
}

/** called after p.update(). The healing blocks run their own timers here (the original ones only heal what the game's
 *  building index knows, and it does not know the blocks of a flying machine). */
function healingBlock(m, p, delta){
    var mender = isMender(p), regen = !mender && isRegenProjector(p);
    if(!mender && !regen) return;
    var blk = p.block;
    var st = healState[p.id];
    if(st === undefined){
        st = {t: mender ? Math.random() * numOr(blk.reload, 200) : 0, log: -1000};
        healState[p.id] = st;
    }
    var eff = numOr(p.efficiency, 0);
    if(!st.seen){
        st.seen = true;
        Log.info("[mb] healer found: " + blk.name + (mender ? " (mender)" : " (regen projector)") + " eff=" + eff.toFixed(2));
    }
    if(eff <= 0){
        // no power / no consumables: nothing heals (the same as on the ground)
        if(m.parts.some(o => !o.dead && bDamaged(o))) healLog(m, p, "healer idle:", "(no power? efficiency is 0)");
        return;
    }
    var every, pct, range;
    if(mender){
        var heat = numOr(p.heat, 1);                                // the block warms up like the original
        st.t += delta * heat;
        every = numOr(blk.reload, 200);
        if(st.t < every) return;
        st.t -= every;
        var phase = numOr(p.phaseHeat, 0);
        range = numOr(blk.range, 40) + phase * numOr(blk.phaseRangeBoost, 0);
        pct = (numOr(blk.healPercent, 12) + phase * numOr(blk.phaseBoost, 0)) / 100 * eff;
    }else{
        st.t += delta * eff;
        every = numOr(blk.mendTime, numOr(blk.reload, 120));
        if(st.t < every) return;
        st.t -= every;
        pct = numOr(blk.healPercent, 12) / 100 * (1 + numOr(blk.optionalMultiplier, 0) * numOr(p.optionalEfficiency, 0));
        range = numOr(blk.range, 14) * TS;                          // the range of a regen projector is in tiles
    }
    var healed = healAround(m, p, range, o => bMaxHealth(o) * pct);
    if(healed > 0) healLog(m, p, "healer pulse:", "healed " + healed + " blocks, " + (pct * 100).toFixed(1) + "%, range " + range.toFixed(0));
    else if(m.parts.some(o => !o.dead && bDamaged(o))) healLog(m, p, "healer pulse reached nobody:", "(damaged blocks are out of range " + range.toFixed(0) + ")");
}

/** runs the original logic of every block of the machine (after the final position of this frame is known) */
function flyLogic(m, delta){
    if(m.mode != "fly") return;
    // ore under the drills depends on where the machine is
    m.oreTimer -= delta;
    if(m.oreTimer <= 0){
        m.oreTimer = 20;
        var moved = Math.abs(m.x - m.lastOre[0]) + Math.abs(m.y - m.lastOre[1]) + Math.abs(signedDiff(m.ang, m.lastOre[2]));
        if(moved > 1.5) refreshOre(m);
    }
    setPartsReal(m);
    var list = m.parts.slice();
    for(var bi = 0; bi < m.boosters.length; bi++){
        if(!m.boosters[bi].dead) bstate(m.boosters[bi]).thrusting = m.thrusting;
    }
    withPocket(m, () => {
        if(m.fall == null){ try{ fireControl(m); }catch(e){ logErr("fireControl", e); } }
        for(var j = 0; j < list.length; j++){
            var p = list[j];
            if(p.dead) continue;
            if(mdLinked(p)){
                // a linked mass driver: its link is a place in the real world, which is not visible from the pocket, so the
                // game's own update would see no target and empty the driver into its neighbours. Only the power is kept
                // up to date here; the sending is done in mdTick.
                try{ p.updateConsumption(); }catch(e){ logErr("driver consumption", e); }
            }else{
                try{ if(isNuclear(p)) updateReactor(p); else p.update(); }catch(e){ logErr("update " + p.block.name, e); }
            }
            try{ healingBlock(m, p, delta); }catch(e){ logErr("healingBlock", e); }
            try{ overdriveBlock(m, p, delta); }catch(e){ logErr("overdriveBlock", e); }
        }
    }, false);
    try{ if(reapDead(m) && machines.indexOf(m) < 0) return; }catch(e){ logErr("reapDead", e); }
    try{ tickBoosters(m, delta); }catch(e){ logErr("tickBoosters", e); }
    if(machines.indexOf(m) < 0) return;
    keepBody(m);
}

// ---------------------------------------------------------------------------
//  possession
// ---------------------------------------------------------------------------
function startPossession(m){
    if(Vars.headless || Vars.player == null) return false;
    if(poss != null) endPossession(false);
    var p = Vars.player;
    var old = p.unit();
    var d = ensureBody(m);
    keepBody(m);
    if(Vars.net.active()){
        // the game's own call: it changes the unit here and tells the others (a plain p.unit(d) is local, the others kept seeing the old unit)
        try{ Packages.mindustry.gen.Call.unitControl(p, d); }catch(eU){ logErr("possess net", eU); }
        if(p.unit() !== d) p.unit(d);
    }else{
        p.unit(d);
    }
    if(old != null && !old.dead && old.spawnedByCore){
        if(isNetHost()){
            try{ Packages.mindustry.gen.Call.unitDespawn(old); }catch(eD){ old.remove(); }      // removed for everybody
        }else{
            old.remove();
        }
    }
    poss = {m: m};
    return true;
}

function endPossession(silent, why){
    if(poss == null) return;
    Log.info("[mb] possession ends: " + (why || "requested"));
    // without any core the player could not respawn: keep driving
    if(!silent && Vars.player != null && Vars.player.team().core() == null){
        say("mb.msg.nocore");
        return;
    }
    var m = poss.m, p = Vars.player, d = m.body;
    poss = null;
    joyX = 0; joyY = 0; joyOn = false;
    try{
        if(p != null && d != null && p.unit() == d){
            if(isNetHost()){
                try{ Packages.mindustry.gen.Call.unitClear(p); }catch(eC){ p.clearUnit(); }
            }else{
                p.clearUnit();
            }
        }
        if(p != null) p.deathTimer = Player.deathDelay + 1;
    }catch(e){
        Log.err("[mb] end possession: " + e);
    }
    if(!silent) say("mb.msg.left");
}

/** per frame: controlled machine that is landed moves cell by cell */
function driveLanded(m, delta, inpArg){
    var inp = inpArg || readInput();
    var ix = inp[0], iy = inp[1];
    if(ix == 0 && iy == 0){
        m.progress = Math.min(m.progress, 1);
        return;
    }
    var dir;
    if(ix != 0 && iy != 0){
        m.flip = 1 - m.flip;
        dir = m.flip == 0 ? (ix > 0 ? 0 : 2) : (iy > 0 ? 1 : 3);
    }else if(ix != 0){
        dir = ix > 0 ? 0 : 2;
    }else{
        dir = iy > 0 ? 1 : 3;
    }
    m.progress += 8 * delta / 60;       // block mode: eight cells per second
    if(m.progress < 1) return;
    m.progress = 1;
    var res = stepMachine(m, dir);
    if(res == "ok"){
        m.progress = 0;
        keepBody(m);
    }else if(Time.globalTime - lastMsg > 120){
        lastMsg = Time.globalTime;
        say(res == "constructing" ? "mb.msg.constructing" : "mb.msg.blocked");
    }
}

function checkPossession(){
    if(poss == null || Vars.headless) return;
    var m = poss.m, p = Vars.player;
    if(machines.indexOf(m) < 0 || hullBuild(m) == null || m.body == null || !m.body.isValid()){
        endPossession(true, "machine=" + (machines.indexOf(m) >= 0) + " hull=" + (hullBuild(m) != null) + " body=" + (m.body != null && m.body.isValid()));
        say("mb.msg.dead");
        return;
    }
    if(p.unit() != m.body){   // the player left by other means (respawn key etc.)
        endPossession(true, "player unit changed to " + p.unit());
    }
}

// ---------------------------------------------------------------------------
//  build mode (G) and layers (Y)
// ---------------------------------------------------------------------------
function hoveredBuilding(){
    if(Vars.headless || Core.input == null) return null;
    var t = Vars.world.tileWorld(Core.input.mouseWorldX(), Core.input.mouseWorldY());
    return t == null ? null : t.build;
}

function machineUnderPoint(wx, wy, team){
    var fl = flyingMachines();
    for(var i = 0; i < fl.length; i++){
        var m = fl[i];
        if(team != null && m.team.id != team.id) continue;
        if(partAtWorld(m, wx, wy) != null) return m;
    }
    var t = Vars.world.tileWorld(wx, wy);
    if(t != null){
        var lm = machineAtTile(t);
        if(lm != null && (team == null || lm.team.id == team.id)) return lm;
    }
    return null;
}

function nearestMachine(x, y, team){
    var best = null, bd = 1e12;
    machines.forEach(m => {
        if(team != null && m.team.id != team.id) return;
        var pos = machinePos(m);
        var d = Mathf.dst2(pos[0], pos[1], x, y);
        if(d < bd){ bd = d; best = m; }
    });
    return best;
}

function pickMachine(){
    var p = Vars.player;
    if(poss != null) return poss.m;
    var m = null;
    if(!Vars.headless && Core.input != null) m = machineUnderPoint(Core.input.mouseWorldX(), Core.input.mouseWorldY(), p.team());
    if(m == null) m = nearestMachine(p.x, p.y, p.team());
    return m;
}

function enterBuildMode(m, pl){
    var remote = pl != null && pl !== Vars.player;
    if(remote) bmRemote[pl.id] = true; else buildMode = true;
    if(m != null){
        m.editor = remote ? pl.id : localPid();
        if(m.mode == "fly"){
            if(!landMachine(m)) return false;
        }
    }
    return true;
}

/** leaves the build mode for one landed machine; returns true when it is flying again (or gone) */
function finishLanded(m){
    var removed = reconcile(m, true);
    if(machines.indexOf(m) < 0){
        if(removed > 0) say("mb.msg.removed", removed);
        return true;
    }
    if(removed > 0) say("mb.msg.removed", removed);
    return takeOff(m);
}

/** a player leaves his build mode (pl: another player; none: the local one). Only his loose blocks and the machines of his team
 *  that are not edited by somebody else are taken to flight / parked. */
function exitBuildMode(pl){
    var remote = pl != null && pl !== Vars.player;
    var pid = remote ? pl.id : localPid();
    var team = remote ? pl.team() : (Vars.player == null ? null : Vars.player.team());
    var ok = true;
    var lost = purgeLoose(pid);          // blocks that never reached a machine (the ones that did are attached first)
    if(lost > 0) say("mb.msg.removed", lost);
    landedMachines().forEach(m => {
        if(team != null && m.team.id !== team.id) return;                              // a machine of another team
        if(m.editor != null && m.editor !== pid && inBuild(m.editor)) return;         // somebody else is still editing it
        m.editor = null;
        if(m.parked){
            // a parked machine stays on the grid: only what was left hanging during the editing is taken down
            var cut = reconcile(m, true);
            if(cut > 0) say("mb.msg.removed", cut);
            return;
        }
        if(finishLanded(m)){ m.exitTries = 0; return; }
        // The machine cannot fly (unfinished blocks, too big ...). The first G press only says why; the second one leaves the
        // machine parked on the grid, so that the build mode can never get stuck on.
        m.exitTries = (m.exitTries || 0) + 1;
        if(m.exitTries >= 2 && machines.indexOf(m) >= 0){
            m.parked = true;
            m.exitTries = 0;
            say("mb.msg.stayparked");
        }else{
            ok = false;
            m.editor = pid;
        }
    });
    if(remote){ if(ok) delete bmRemote[pl.id]; }
    else buildMode = !ok;
    saveDirty = true;
    return ok;
}

function toggleBuild(){
    if(Vars.net.client()){ var a = aimXY(); netCmd("build|" + a[0] + "|" + a[1]); return; }
    if(buildMode){ exitBuildMode(); return; }
    enterBuildMode(pickMachine());
}

/** Park button (HUD): lands the machine the player drives (else the one under the cursor / the nearest one) WITHOUT the
 *  build mode, or takes a parked machine off again. A machine that is being edited in the build mode is left to G. */
function parkTarget(){
    var p = Vars.player;
    if(poss != null) return poss.m;
    if(p == null || p.team() == null) return null;
    return nearestMachine(p.x, p.y, p.team());      // the cursor is on the button, so only the distance to the player counts
}

function togglePark(){
    if(Vars.net.client()){ var a = aimXY(); netCmd("park|" + a[0] + "|" + a[1]); return; }
    if(Vars.player == null || Vars.player.team() == null) return;
    parkMachine(parkTarget());
}

function parkMachine(m){
    if(m == null){ say("mb.msg.nomachine"); return; }
    if(m.mode == "fly"){
        if(landMachine(m, true)) say("mb.msg.parked");
    }else if(m.parked){
        if(takeOff(m)) say("mb.msg.unparked");
    }else{
        say("mb.msg.parkbuild");
    }
}

/** Y in build mode: moves the block under the cursor between the world layer and the machine layer */
function toggleLayer(b){
    if(b == null){ say("mb.msg.nolayerblock"); return; }
    if(b.team !== actor().team()) return;
    if(isConstructing(b)){ return; }
    var m = machineOfBuild(b);
    if(m != null){
        coverTiles(b).forEach(p => { delete m.cells[p]; delete m.pending[p]; });
        reindexAll();
        reconcile(m, false);
        say("mb.msg.toworld");
        return;
    }
    var team = b.team;
    var landed = landedMachines().filter(x => x.team.id == team.id);
    var touch = null;
    for(var i = 0; i < landed.length && touch == null; i++) if(touches(landed[i], b)) touch = landed[i];
    if(touch != null){
        coverTiles(b).forEach(p => { touch.cells[p] = true; });
        reindexAll();
        reconcile(touch, false);
        say("mb.msg.tomachine");
        return;
    }
    if(isHull(b)){
        createMachine(b);
        say("mb.msg.created");
        return;
    }
    say("mb.msg.notouch");
}

// ---- Y dragged over a square (like the selection of F / B or the deconstruction square) ---------------------
var layerDrag = null;       // {sx, sy, cx, cy} tiles: where Y went down, where the cursor is now (build mode only)

/** tile under the cursor (clamped to the map) */
function mouseTile(){
    var x = Math.round(Core.input.mouseWorldX() / TS), y = Math.round(Core.input.mouseWorldY() / TS);
    return [Math.max(0, Math.min(Vars.world.width() - 1, x)), Math.max(0, Math.min(Vars.world.height() - 1, y))];
}

/** buildings that cover at least one tile of the square (tile coordinates, corners in any order);
 *  team == null: buildings of any team */
function buildingsInRect(tx0, ty0, tx1, ty1, team){
    var minX = Math.min(tx0, tx1), maxX = Math.max(tx0, tx1), minY = Math.min(ty0, ty1), maxY = Math.max(ty0, ty1);
    var out = [];
    if(minX == maxX && minY == maxY){
        var t = Vars.world.tile(minX, minY);
        if(t != null && t.build != null && (team == null || sameTeam(t.build, team))) out.push(t.build);
        return out;
    }
    var cx = (minX + maxX) / 2 * TS, cy = (minY + maxY) / 2 * TS;
    var radius = Math.sqrt(Math.pow((maxX - minX + 1) * TS, 2) + Math.pow((maxY - minY + 1) * TS, 2)) / 2 + 8;
    var seen = {};
    Vars.indexer.eachBlock(null, cx, cy, radius, boolf(b => true), cons(b => {
        if(b.tile == null || (team != null && !sameTeam(b, team))) return;
        var key = b.pos();
        if(seen[key]) return;
        var s = b.block.size, off = originShift(s);
        var bx = b.tile.x + off, by = b.tile.y + off;     // first covered tile
        if(bx > maxX || bx + s - 1 < minX || by > maxY || by + s - 1 < minY) return;
        seen[key] = true;
        out.push(b);
    }));
    return out;
}

/** Which way a square moves the blocks in it: "join" (world -> machine) or "leave" (machine -> world).
 *  The block Y went down on decides (a world block: join, a machine block: leave). When Y went down on an empty tile,
 *  the square joins if it holds any block of the world, otherwise it lets the machine blocks leave. */
function layerDirection(blds, startBuild){
    var team = actor().team();
    if(startBuild != null && sameTeam(startBuild, team) && !isConstructing(startBuild)){
        return machineOfBuild(startBuild) != null ? "leave" : "join";
    }
    for(var i = 0; i < blds.length; i++){
        if(!isConstructing(blds[i]) && machineOfBuild(blds[i]) == null) return "join";
    }
    return "leave";
}

/** Y over a square with several blocks: they all move the same way (see layerDirection).
 *  join:  blocks of the world are attached from the machine outwards, so a whole chain of blocks can join at once;
 *         a core / storage that touches no machine starts a new one (like Y on it does).
 *  leave: blocks of machines go back to the world; whatever they were holding is marked red as usual. */
function toggleLayerArea(blds, dir){
    var team = actor().team();
    var own = blds.filter(b => !isConstructing(b));
    var touched = [];
    var mark = m => { if(touched.indexOf(m) < 0) touched.push(m); };
    var moved = 0;

    if(dir == "leave"){
        var inMachine = own.filter(b => machineOfBuild(b) != null);
        var owners = inMachine.map(b => machineOfBuild(b));
        inMachine.forEach((b, i) => {
            coverTiles(b).forEach(p => { delete owners[i].cells[p]; delete owners[i].pending[p]; });
            mark(owners[i]);
            moved++;
        });
    }else{
        // blocks of the world join the machines they touch (repeated: a block may touch only a block that has just joined)
        var landed = landedMachines().filter(x => x.team.id == team.id);
        var left = own.filter(b => machineOfBuild(b) == null);
        while(left.length > 0){
            var progress = true;
            while(progress){
                progress = false;
                for(var i = left.length - 1; i >= 0; i--){
                    var b = left[i], touch = null;
                    for(var j = 0; j < landed.length && touch == null; j++){
                        if(touches(landed[j], b)) touch = landed[j];
                    }
                    if(touch == null) continue;
                    coverTiles(b).forEach(p => { touch.cells[p] = true; });
                    mark(touch);
                    left.splice(i, 1);
                    moved++;
                    progress = true;
                }
            }
            // whatever is left touches no machine: a core / storage becomes a machine of its own, the blocks around it
            // may then join it in the next round
            var hi = -1;
            for(var k = 0; k < left.length && hi < 0; k++) if(isHull(left[k])) hi = k;
            if(hi < 0) break;
            var hull = left.splice(hi, 1)[0];
            var made = createMachine(hull);
            landed.push(made);
            mark(made);
            moved++;
        }
    }

    // every machine that changed is checked once (blocks that lost their link are marked red, touching machines merge)
    reindexAll();
    touched.forEach(m => { if(machines.indexOf(m) >= 0) reconcile(m, false); });
    saveDirty = true;

    if(moved == 0) say(dir == "join" ? "mb.msg.areanotouch" : "mb.msg.areaempty");
    else say(dir == "join" ? "mb.msg.areajoin" : "mb.msg.arealeave", moved);
}

/** Y was released: a plain tap works on one block, a dragged square on all the blocks in it */
function finishLayerSelection(x0, y0, x1, y1, startBuild){
    if(Vars.net.client()){
        netCmd("area|" + x0 + "|" + y0 + "|" + x1 + "|" + y1 + "|" + (startBuild == null || startBuild.tile == null ? -1 : startBuild.tile.x) + "|" + (startBuild == null || startBuild.tile == null ? -1 : startBuild.tile.y));
        return;
    }
    if(x0 == x1 && y0 == y1){
        var t = Vars.world.tile(x0, y0);
        toggleLayer(t == null ? null : t.build);
        return;
    }
    var blds = buildingsInRect(x0, y0, x1, y1, actor().team());
    if(blds.length == 0){ say("mb.msg.areaempty"); return; }
    if(blds.length == 1) toggleLayer(blds[0]);
    else toggleLayerArea(blds, layerDirection(blds, startBuild));
}

function startLayerDrag(){
    var t = mouseTile();
    var tile = Vars.world.tile(t[0], t[1]);
    layerDrag = {sx: t[0], sy: t[1], cx: t[0], cy: t[1], start: tile == null ? null : tile.build, list: null, key: "", stamp: -1000};
}

/** every frame while the square is being dragged; `blocked` = a dialog or a text field took the keyboard */
function updateLayerDrag(blocked){
    if(layerDrag == null) return;
    if(!buildMode || blocked || Vars.state.isPaused()){ layerDrag = null; return; }
    var t = mouseTile();
    layerDrag.cx = t[0];
    layerDrag.cy = t[1];
    if(Core.input.keyDown(KeyCode.y)) return;       // still held
    var d = layerDrag;
    layerDrag = null;
    finishLayerSelection(d.sx, d.sy, d.cx, d.cy, d.start);
}

// ---- R in build mode: turns the front (green arrow) of a machine -----------------------------------------
/** the machine R turns: the one under the cursor, else the one being driven, else the landed machine nearest to the cursor.
 *  fromUi (the arrow buttons of the panel): the cursor means nothing on a phone, so the machine being driven, else the
 *  landed machine nearest to the middle of the screen. */
function frontMachine(fromUi){
    var team = Vars.player.team();
    var mx = Core.input.mouseWorldX(), my = Core.input.mouseWorldY();
    if(fromUi){
        mx = Core.camera.position.x; my = Core.camera.position.y;
    }else{
        var m = machineAtTile(Vars.world.tileWorld(mx, my));
        if(m != null && m.team.id == team.id) return m;
    }
    if(poss != null && poss.m.mode == "land") return poss.m;
    var best = null, bd = 1e12;
    landedMachines().forEach(x => {
        if(x.team.id != team.id) return;
        var pos = machinePos(x);
        var d = Mathf.dst2(pos[0], pos[1], mx, my);
        if(d < bd){ bd = d; best = x; }
    });
    return best;
}

/** the arrow buttons of the panel (the same as R / Shift+R) */
function turnFrontButton(steps){
    if(!buildMode) return;
    if(Vars.net.client()){ netCmd("front|" + steps + "|" + Core.camera.position.x + "|" + Core.camera.position.y); return; }
    var m = frontMachine(true);
    if(m == null){ say("mb.msg.nomachine"); return; }
    turnFront(m, steps);
}

function rotateFrontKey(){
    // a rotatable block under the cursor (conveyor ...) is turned by the game itself on R: leave R to it
    var hb = hoveredBuilding();
    if(hb != null && hb.block.rotate && hb.interactable(Vars.player.team())) return;
    var back = Core.input.keyDown(KeyCode.shiftLeft) || Core.input.keyDown(KeyCode.shiftRight);
    if(Vars.net.client()){ var a = aimXY(); netCmd("front|" + (back ? -1 : 1) + "|" + a[0] + "|" + a[1]); return; }
    var m = frontMachine();
    if(m == null) return;
    turnFront(m, back ? -1 : 1);
}

function togglePossess(){
    if(Vars.net.client()){
        var u = Vars.player == null ? null : Vars.player.unit();
        var driving = netDriving || (u != null && u.type == driverType);
        if(driving){
            netCmd("leave");
            // local hint: host will clear the unit; if stuck, clear locally too
            try{ if(u != null && u.type == driverType) Vars.player.clearUnit(); }catch(eL){}
        }else{
            var a = aimXY();
            netCmd("poss|" + a[0] + "|" + a[1]);
        }
        return;
    }
    if(poss != null){ endPossession(false); return; }
    if(Vars.player == null || Vars.player.team() == null) return;
    var m = pickMachine();
    if(m == null){ say("mb.msg.nomachine"); return; }
    if(startPossession(m)) say("mb.msg.entered");
}

// a DOUBLE tap on a machine possesses it (a single stray tap only remembers the machine and says what to do)
var lastTap = {m: null, t: 0};
var shipPick = null, shipPickDone = 0;

/** the player is to tap the store a control block unloads into / loads from (which = "dest" / "src"; the settings window is
 *  closed meanwhile) */
function shipStartPick(b, which){
    shipPick = {b: b, which: which};
    try{ Vars.control.input.config.hideConfig(); }catch(e){ /* the window stays: the tap still works */ }
    say("mb.msg.pickdest");
}

onEvent(TapEvent, e => {
    if(shipPick == null || Vars.headless || e.player != Vars.player) return;
    var pick = shipPick;
    shipPick = null;
    shipPickDone = Number(Time.millis());
    var bd = e.tile == null ? null : e.tile.build;
    if(bd == null || bd.team != Vars.player.team() || (bd.items == null && bd.liquids == null)){
        say("mb.msg.pickcancel");
        return;
    }
    var kx = pick.which === "src" ? "sx" : "dx", ky = pick.which === "src" ? "sy" : "dy";
    shipOptSet(pick.b, kx, bd.tile.x);
    shipOptSet(pick.b, ky, bd.tile.y);
    say(pick.which === "src" ? "mb.msg.srcset" : "mb.msg.destset", bd.block.localizedName);
});

onEvent(TapEvent, e => {
    if(Vars.headless || e.player != Vars.player || Vars.net.client()) return;
    if(shipPick != null || Number(Time.millis()) - shipPickDone < 400) return;     // that tap chose a store
    if(poss != null || buildMode) return;
    if(Vars.control.input.block != null || Vars.control.input.commandMode) return;
    var m = machineUnderPoint(Core.input.mouseWorldX(), Core.input.mouseWorldY(), Vars.player.team());
    if(m == null){ lastTap.m = null; return; }
    var now = Number(Time.millis());
    if(lastTap.m === m && now - lastTap.t < 700){
        lastTap.m = null;
        if(startPossession(m)) say("mb.msg.entered");
    }else{
        lastTap.m = m;
        lastTap.t = now;
        say("mb.msg.tapagain");
    }
});

// ---------------------------------------------------------------------------
//  free placement: in the build mode (G) the blocks that are tied to the ground (drills, pumps, thermal generators ...)
//  can be put anywhere, ore, water or heat under them is not needed.
//  Build.validPlace is static and asks block.canPlaceOn() of the block itself, so the game cannot be told to skip it.
//  Instead, when the game refuses such a block only because of the ground, the mod starts its construction itself
//  (the same steps as Build.beginPlace, minus the ground check); the builder unit then finishes it like any other block.
// ---------------------------------------------------------------------------
var TERRAIN_CLASSES = [];     // Pump also covers SolidPump / Fracker; a class missing in some game version is skipped, not fatal
[() => Drill, () => BeamDrill, () => WallCrafter, () => Pump, () => ThermalGenerator, () => AttributeCrafter].forEach(get => {
    try{ TERRAIN_CLASSES.push(get()); }catch(e){ logErr("terrain class", e); }
});
var surrogates = {};

/** blocks whose canPlaceOn() looks at the floor, ore or walls under them */
function isTerrainBlock(block){
    if(block == null) return false;
    for(var i = 0; i < TERRAIN_CLASSES.length; i++){
        if(block instanceof TERRAIN_CLASSES[i]) return true;
    }
    return false;
}

/** a plain block of the same size without any ground rule of its own: asking the game about it tells whether everything
 *  else (other blocks, units, walls, the edge of the map, enemy core zones ...) allows a block of that size here */
function surrogateFor(size){
    if(surrogates[size] !== undefined) return surrogates[size];
    var pref = [Blocks.copperWall, Blocks.copperWallLarge, Blocks.vault, Blocks.spectre, Blocks.meltdown];
    var pick = null;
    for(var i = 0; i < pref.length && pick == null; i++){
        if(pref[i] != null && pref[i].size == size) pick = pref[i];
    }
    surrogates[size] = pick;
    return pick;
}

/** true when `block` is refused at (x, y) only because of the ground under it and may be placed anyway in the build mode */
function freePlaceOk(block, x, y, rot){
    if(!buildMode || !isTerrainBlock(block) || actor() == null) return false;
    var team = actor().team();
    var tile = Vars.world.tile(x, y);
    if(tile == null) return false;
    if(Build.validPlace(block, team, x, y, rot)) return false;      // the game allows it on its own
    if(block.canPlaceOn(tile, team, rot)) return false;             // refused for another reason: not the ground
    if(!(block.isPlaceable() && block.environmentBuildable()) || block.isOverPlacementLimit(team)) return false;
    var sur = surrogateFor(block.size);
    // checkVisible = false: the tiles must be empty (or hold only boulders), nothing is replaced
    return sur != null && Build.validPlace(sur, team, x, y, rot, false);
}

/** like the builder, the construction starts only when the core has at least one item of every kind needed */
function hasStartResources(block, team){
    var rules = Vars.state.rules;
    if(rules.infiniteResources || team.rules().infiniteResources) return true;
    var core = team.core();
    if(core == null) return false;
    var reqs = block.requirements;
    for(var i = 0; i < reqs.length; i++){
        if(!core.items.has(reqs[i].item, Math.min(Math.round(reqs[i].amount * rules.buildCostMultiplier), 1))) return false;
    }
    return true;
}

/** origin tile of a block under the cursor, the way the game computes it (even sizes sit between four tiles) */
function placeOrigin(block){
    return [Math.round((Core.input.mouseWorldX() - block.offset) / TS), Math.round((Core.input.mouseWorldY() - block.offset) / TS)];
}

/** Build.beginPlace without its validation: puts a construction site of `block` on the tile and queues the build plan */
function beginFreePlace(block, x, y, rot, config){
    var team = actor().team(), unit = actor().unit();
    var tile = Vars.world.tile(x, y);
    if(tile == null) return false;
    // boulders in the way are removed, as the game does it
    tile.getLinkedTilesAs(block, cons(t => {
        if(t.block() != Blocks.air && t.block().alwaysReplace) t.remove();
    }));
    var previous = tile.block();
    var sub = ConstructBlock.get(block.size);
    block.beforePlaceBegan(tile, previous);
    tile.setBlock(sub, team, rot);
    var site = tile.build;
    if(site == null || !isConstructing(site)) return false;
    site.setConstruct(previous.size == sub.size ? previous : Blocks.air, block);
    site.prevBuild = new Seq();
    Events.fire(new BlockBuildBeginEvent(tile, team, unit, false));
    block.placeBegan(tile, previous, unit);
    if(unit != null && unit.canBuild()){
        var plan = new BuildPlan(x, y, rot, block);
        if(config !== undefined && config !== null) plan.config = config;      // a block of a schematic keeps its setting
        unit.addBuild(plan);
    }
    return true;
}

// ---------------------------------------------------------------------------
//  pasted schematics: the game drops from a pasted schematic every block it refuses on this ground (drills with no ore
//  under them, pumps with no water ...) - they are never queued, so they were missing in the built machine.
//  The mod starts their construction itself at the moment the schematic is placed.
//    PC:      the schematic hangs on the cursor (input.selectPlans) and a click places it (DesktopInput: flushPlans)
//    mobile:  the plans are placed by the confirm button: selectPlans is emptied and the plans go to `removals`
// ---------------------------------------------------------------------------
var schemSnapshot = [];      // mobile: the plans that hung on the screen at the previous frame

function planList(seq){
    var out = [];
    for(var i = 0; i < seq.size; i++) out.push(seq.get(i));
    return out;
}

/** starts the construction of every ground-bound block of the plans that the game itself is going to drop; returns how many */
function freePlacePlans(plans){
    var team = Vars.player.team(), started = 0, noRes = false;
    for(var i = 0; i < plans.length; i++){
        var pl = plans[i];
        if(pl.breaking || pl.block == null || !isTerrainBlock(pl.block)) continue;
        if(!freePlaceOk(pl.block, pl.x, pl.y, pl.rotation)) continue;
        if(Vars.net.client()){ netCmd("fp|" + pl.block.name + "|" + pl.x + "|" + pl.y + "|" + pl.rotation); started++; continue; }
        if(!hasStartResources(pl.block, team)){ noRes = true; continue; }
        if(beginFreePlace(pl.block, pl.x, pl.y, pl.rotation, pl.config)) started++;
    }
    if(noRes) say("mb.msg.freeres");
    return started;
}

/** called every frame of the game (before the input of this frame is handled) */
function trackSchematic(){
    var input = Vars.control.input;
    if(!buildMode || Vars.player == null || Vars.player.dead() || input == null){
        schemSnapshot = [];
        return;
    }
    var plans = input.selectPlans;
    if(!Vars.mobile){
        // the click that places the schematic (the same condition DesktopInput checks before it calls flushPlans)
        if(plans.size > 0 && Core.input.keyTap(Binding.select) && !Core.scene.hasMouse() && !Core.input.keyDown(Binding.breakBlock)){
            freePlacePlans(planList(plans));
        }
        return;
    }
    if(plans.size > 0){
        schemSnapshot = planList(plans);
        return;
    }
    if(schemSnapshot.length == 0) return;
    var snap = schemSnapshot;
    schemSnapshot = [];
    // the confirm button hands the plans over to `removals` (they fade out there); cancelling just clears the list
    var rem = input.removals;
    if(rem === undefined || rem === null) return;
    var confirmed = false;
    for(var i = 0; i < snap.length && !confirmed; i++){
        if(!snap[i].breaking && rem.contains(snap[i], true)) confirmed = true;
    }
    if(confirmed) freePlacePlans(snap);
}

// a click / tap in the build mode with a ground-bound block selected, where the game itself refuses the place
onEvent(TapEvent, e => {
    if(Vars.headless || !buildMode || e.player != Vars.player) return;
    var input = Vars.control.input;
    var block = input.block;
    if(block == null || input.commandMode || !isTerrainBlock(block)) return;
    var x, y;
    if(Vars.mobile){
        x = e.tile.x; y = e.tile.y;                  // a tap places the block on the tapped tile
    }else{
        var o = placeOrigin(block);
        x = o[0]; y = o[1];
    }
    var rot = input.rotation;
    if(!freePlaceOk(block, x, y, rot)) return;
    if(Vars.net.client()){ netCmd("fp|" + block.name + "|" + x + "|" + y + "|" + rot); return; }
    if(!hasStartResources(block, Vars.player.team())){ say("mb.msg.freeres"); return; }
    beginFreePlace(block, x, y, rot);
});

// ---------------------------------------------------------------------------
//  events
// ---------------------------------------------------------------------------
onEvent(BlockBuildEndEvent, e => {
    if(busy || inPocketOp > 0 || e.breaking) return;
    if(Vars.net.client()) return;   // host attaches blocks; clients must not create a parallel registry
    var tile = e.tile;
    if(tile == null || tile.build == null) return;
    var b = tile.build;
    // a finished block that replaces a machine tile joins automatically (upgrades; also for a parked machine, outside the build mode)
    var own = machineAtTile(tile);
    if(own != null){
        coverTiles(b).forEach(p => { own.cells[p] = true; });
        reindexAll();
        dirty = true;
        return;
    }
    var pid = builderPid(e.unit);
    if(!(pid == null ? anyBuild() : inBuild(pid))) return;        // only the build mode of the player who built the block counts
    var landed = landedMachines().filter(m => m.team.id == e.team.id);
    var touch = null;
    for(var i = 0; i < landed.length && touch == null; i++) if(touches(landed[i], b)) touch = landed[i];
    if(touch != null){
        if(touch.editor == null && pid != null) touch.editor = pid;
        coverTiles(b).forEach(p => { touch.cells[p] = true; });
        reindexAll();
        dirty = true;
        return;
    }
    if(isHull(b)){
        var newM = createMachine(b);
        if(newM != null && pid != null) newM.editor = pid;
        // blocks of a schematic that were ready before this core / storage are attached in processDirty (adoptLoose)
        dirty = true;
        return;
    }
    // Placed in the machine build mode, but not attached to anything yet: red, and removed when the mode ends - unless
    // a chain of blocks reaches a machine first (a schematic is built in any order, its storage may come last).
    // It is kept in one global list, not in the pending list of the "nearest" machine: that machine may have nothing
    // to do with the hull the block will finally be attached to.
    var ownerKey = pid == null ? "p" : "p" + pid;
    coverTiles(b).forEach(p => { loose[p] = ownerKey; });
    dirty = true;
});

function landedTouched(pos){
    for(var i = 0; i < machines.length; i++){
        var m = machines[i];
        if(m.mode == "land" && (m.cells[pos] || m.pending[pos])) return true;
    }
    return false;
}

onEvent(TileChangeEvent, e => {
    if(busy || inPocketOp > 0 || Vars.net.client()) return;
    var t = e.tile;
    if(t == null) return;
    if(landedTouched(t.pos()) || loose[t.pos()]) dirty = true;
});

onEvent(TileChangeEvent, e => {
    if(!busy || inPocketOp > 0 || !isNetHost()) return;
    var t = e.tile;
    if(t != null) netTileQ[t.pos()] = true;
});

onEvent(BlockDestroyEvent, e => {
    if(busy || inPocketOp > 0 || Vars.net.client()) return;
    if(landedTouched(e.tile.pos()) || loose[e.tile.pos()]) dirty = true;
});

function processDirty(){
    if(!dirty || busy || Vars.net.client()) return;
    dirty = false;
    adoptLoose();       // blocks that were ready before their core / storage join it now
    landedMachines().forEach(m => {
        if(machines.indexOf(m) < 0) return;
        reconcile(m, false);
    });
}

// ---------------------------------------------------------------------------
//  persistence (stored in the rules of the save)
// ---------------------------------------------------------------------------
function serializePart(b){
    var bo = new java.io.ByteArrayOutputStream();
    var w = new Packages.arc.util.io.Writes(new java.io.DataOutputStream(bo));
    w.b(b.version());
    b.writeAll(w);
    var out = {n: b.block.name, x: b.tile.x, y: b.tile.y, r: blockRot(b), d: "" + java.util.Base64.getEncoder().encodeToString(bo.toByteArray())};
    var bs = bstates[b.id];     // the item a fuel booster is burning right now
    if(bs !== undefined && bs.burn > 0 && bs.item != null){
        out.bu = bs.burn;
        out.bi = bs.item.id;
    }
    if(isShipControl(b) && shipCfg[b.id] != null) out.sc = shipCode(shipCfg[b.id]);   // the ore / liquid of a ship control
    if(isShipControl(b)) out.so = shipOptCode(b);
    return out;
}

function saveRegistry(){
    saveDirty = false;
    try{
        var out = {bm: buildMode, ms: machines.map(m => {
            if(m.mode == "land") return {
                k: "l", t: m.team.id, a: m.anchor, c: Object.keys(m.cells).map(Number), fr: frontIndex(m), pk: m.parked ? 1 : 0,
                sc: shipSaveList(membersOf(m.cells, m.team))
            };
            return {
                k: "f", t: m.team.id, x: m.x, y: m.y, g: m.ang, sg: m.savedAng, off: m.off, ref: m.ref, pw: m.pw, ph: m.ph,
                hull: m.parts.indexOf(m.hull), parts: m.parts.map(serializePart), fr: frontIndex(m)
            };
        })};
        Vars.state.rules.tags.put(TAG, JSON.stringify(out));
    }catch(e){
        Log.err("[mb] save failed: " + e);
    }
}

function newMachineObj(team){
    return {
        id: nextId++, team: team, mode: "land",
        anchor: 0, cells: {}, pending: {},
        parts: [], hull: null, pocket: null, off: [0, 0], ref: [0, 0], realTiles: null,
        x: 0, y: 0, ang: 0, savedAng: 0, vx: 0, vy: 0, radius: 12,
        body: null, stats: null, oreCache: {}, oreStamp: 0, oreTimer: 0, lastOre: [0, 0, 0],
        target: null, targetTimer: 0, turrets: [], boosters: [], thrusting: false, flip: 0, progress: 0,
        front: 1, parked: false
    };
}

function loadFlying(o){
    var m = newMachineObj(Team.get(o.t));
    m.mode = "fly";
    m.front = frontFromSave(o);
    m.x = o.x; m.y = o.y; m.ang = o.g; m.savedAng = o.sg; m.off = o.off; m.ref = o.ref;
    makePocket(m, o.pw, o.ph);
    var made = [];
    withPocket(m, () => {
        o.parts.forEach(po => {
            var bname = LEGACY_BLOCKS.hasOwnProperty(po.n) ? LEGACY_BLOCKS[po.n] : po.n;
            var block = Vars.content.getByName(ContentType.block, bname);
            if(block == null) return;
            var b = block.newBuilding().create(block, m.team);
            placeInPocket(m, {px: po.x, py: po.y, block: block, team: m.team, rot: po.r, b: b});
            if(po.sc !== undefined) shipCfg[b.id] = shipFromCode(po.sc);
            if(po.so !== undefined) shipOptFrom(b, po.so);
            if(po.bu > 0 && po.bi !== undefined){
                var burnItem = Vars.content.item(po.bi);
                if(burnItem != null){
                    var bs = bstate(b);
                    bs.burn = po.bu;
                    bs.item = burnItem;
                }
            }
            try{
                var rd = new Packages.arc.util.io.Reads(new java.io.DataInputStream(new java.io.ByteArrayInputStream(java.util.Base64.getDecoder().decode(po.d))));
                var rev = rd.b();
                b.readAll(rd, rev);
            }catch(e){
                Log.err("[mb] part read failed " + po.n + ": " + e);
            }
            made.push(b);
        });
        made.forEach(b => { try{ b.afterReadAll(); }catch(e){} });
        made.forEach(b => { b.updateProximity(); });
    }, true);
    m.parts = made;
    setPartsReal(m);
    var hi = o.hull >= 0 && o.hull < o.parts.length ? o.parts[o.hull] : null;
    m.hull = made.filter(b => hi != null && b.tile.x == hi.x && b.tile.y == hi.y)[0] || made.filter(isHull)[0] || null;
    return m;
}

function loadRegistry(){
    machines = [];
    cellIndex = {};
    partIndex = {};
    bstates = {};
    loose = {};
    poss = null;
    dirty = false;
    buildMode = false;
    bmRemote = {};
    shipCfg = {}; shipOpt = {};
    shipMap = null;                 // the map of the world is read again (ores and liquids may differ)
    inheritedBullets = new java.util.IdentityHashMap();
    // bodies that were saved with the world are stale: they are recreated below
    // (collected first and removed afterwards: removing inside the loop made it skip every other body, and those stayed as phantoms)
    var stale = [];
    Groups.unit.each(u => u.type == driverType, u => { stale.push(u); });
    stale.forEach(u => { try{ u.remove(); }catch(e0){ logErr("remove stale body", e0); } });
    bodyRepair = 45;            // the bodies are checked again a little after the world has settled
    bodyRepairRounds = 0;
    try{
        var s = Vars.state.rules.tags.get(TAG);
        if(s == null || s == "") return;
        var data = JSON.parse(s);
        buildMode = !!data.bm;
        data.ms.forEach(o => {
            if(o.k == "l"){
                var m = newMachineObj(Team.get(o.t));
                m.front = frontFromSave(o);
                m.anchor = o.a;
                m.parked = o.pk === 1;
                o.c.forEach(p => { m.cells[p] = true; });
                m.shipSaved = o.sc || [];
                machines.push(m);
            }else{
                var f = loadFlying(o);
                machines.push(f);
            }
        });
        reindexAll();
        machines.slice().forEach(m => {
            if(m.mode == "land"){
                reconcile(m, false);
            }else if(m.hull == null){
                destroyMachine(m);
            }else{
                partsChanged(m);
                refreshOre(m);
                ensureBody(m);
                keepBody(m);
            }
        });
        if(landedMachines().some(x => !x.parked)) buildMode = true;   // parked machines do not need the build mode
        // the ore / liquid of the ship control blocks of landed machines: found again by their tiles
        machines.forEach(m => {
            (m.shipSaved || []).forEach(e => {
                var t = Vars.world.tile(e[0], e[1]);
                if(t != null && isShipControl(t.build)){
                    shipCfg[t.build.id] = shipFromCode(e[2]);
                    shipOptFrom(t.build, e[3]);
                }
            });
            m.shipSaved = null;
        });
    }catch(e){
        Log.err("[mb] load failed: " + e + (e.stack ? "\n" + e.stack : ""));
    }
}

onEvent(WorldLoadEvent, () => { loadRegistry(); });
onEvent(ResetEvent, () => {
    machines = []; cellIndex = {}; partIndex = {}; bstates = {}; loose = {}; poss = null; dirty = false; buildMode = false; bmRemote = {};
    shipCfg = {}; shipOpt = {}; shipMap = null;
    inheritedBullets = new java.util.IdentityHashMap();
});
onEvent(SaveWriteEvent, () => saveRegistry());

// a player who leaves in his build mode: his loose blocks and machines are taken care of, the mode is forgotten
try{
    onEvent(Packages.mindustry.game.EventType.PlayerLeave, e => {
        try{
            var lp = e.player;
            if(lp == null || !isNetHost()) return;
            if(bmRemote[lp.id] === true){
                ctxPl = lp;
                try{ exitBuildMode(lp); }finally{ ctxPl = null; }
                delete bmRemote[lp.id];
            }
            delete netBmSent[lp.id];
        }catch(eL){ logErr("player leave", eL); }
    });
}catch(eLeave){ Log.err("[mb] the leave handler could not be set: " + eLeave); }

// ---------------------------------------------------------------------------
//  per-frame logic
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
//  network: the machines live in the memory of the host only, so a client never knew about the flying ones. The host
//  now tells every client what a flying machine looks like (rare, reliable) and where it is (often, may be lost); the
//  clients that have the mod draw it from that. Landed machines are ordinary blocks and everybody sees them already.
// ---------------------------------------------------------------------------
var netSig = {}, netPoseTimer = 0, netStructTimer = 0, netStateTimer = 0, netWarned = false;
var netLastBm = null, netMeTimer = 0, netBmSent = {}, netNeedAt = {}, netRelPoseTimer = 0;
// Real tiles that the mod itself changed (take off, land, move, remove): tile.setBlock does not go over the network, so the
// host collects them here and sends the final state of each one to the clients in one batch per frame (netFlushTiles / netOnTiles).
var netTileQ = {};

// ---------------------------------------------------------------------------
//  multiplayer commands. The host (server) is the only place where the machines are simulated. A player who is not the host
//  sends it short commands ("mb-cmd": drive / leave / build mode / park / turn the front / layers / ground-bound block) and,
//  while driving, the stick and the turn keys ("mb-in", often). The server carries a command out for that player (ctxPl) and
//  sends back the messages ("mb-msg"), the state of the build mode ("mb-bm") and the place of the machine he drives ("mb-me").
//  Aiming and shooting travel with the player itself (the game syncs mouseX / mouseY / shooting).
// ---------------------------------------------------------------------------
function remoteFresh(rec){ return Time.globalTime - rec.last < 40; }
function remoteInput(rec){
    if(rec == null || !remoteFresh(rec)) return [0, 0];
    return [Mathf.clamp(rec.ix, -1, 1), Mathf.clamp(rec.iy, -1, 1)];
}

/** server: the machine a remote player points at (else the one he drives, else the nearest to his unit) */
function pickMachineFor(pl, wx, wy){
    var r = remoteOfPlayer(pl);
    if(r != null) return r.m;
    var m = machineUnderPoint(wx, wy, pl.team());
    if(m == null) m = nearestMachine(pl.x, pl.y, pl.team());
    return m;
}

function releaseRemote(rec, silent, dead){
    delete remotes[rec.pl.id];
    var pl = rec.pl;
    try{
        // always clear control: unit type checks fail when the body was rebuilt
        try{ Packages.mindustry.gen.Call.unitControl(pl, null); }catch(e0){}
        try{ Packages.mindustry.gen.Call.unitClear(pl); }catch(e1){
            try{ pl.clearUnit(); }catch(e2){}
        }
        try{ pl.deathTimer = Player.deathDelay + 1; }catch(e3){}
    }catch(e){ logErr("release remote", e); }
    if(!silent){
        ctxPl = pl;
        say(dead ? "mb.msg.dead" : "mb.msg.left");
        ctxPl = null;
    }
}

function startRemote(pl, m){
    if(m == null){ ctxPl = pl; say("mb.msg.nomachine"); ctxPl = null; return; }
    if(isDriven(m) && !(remoteOfPlayer(pl) != null && remoteOfPlayer(pl).m === m)){ ctxPl = pl; say("mb.msg.busy"); ctxPl = null; return; }
    var old = remoteOfPlayer(pl);
    if(old != null) releaseRemote(old, true, false);
    var d = ensureBody(m);
    keepBody(m);
    Packages.mindustry.gen.Call.unitControl(pl, d);
    remotes[pl.id] = {pl: pl, m: m, ix: 0, iy: 0, spin: 0, last: Time.globalTime, lastBody: d};
    ctxPl = pl; say("mb.msg.entered"); ctxPl = null;
}

/** every tick on the server: a remote driver whose machine is gone, whose body was replaced, or who left the machine */
function remoteTick(){
    for(var k in remotes){
        var rec = remotes[k], pl = rec.pl, m = rec.m;
        if(Groups.player.getByID(pl.id) !== pl){ delete remotes[k]; continue; }
        if(machines.indexOf(m) < 0 || hullBuild(m) == null){ releaseRemote(rec, false, true); continue; }
        var u = pl.unit();
        if(m.body != null && m.body.isValid() && u === m.body){ rec.lastBody = m.body; continue; }
        if(u === rec.lastBody && !(m.body != null && m.body.isValid() && m.body === u)){
            // the body of the machine was replaced: the player is moved over to the new one
            var nb = ensureBody(m);
            if(nb != null){ try{ Packages.mindustry.gen.Call.unitControl(pl, nb); rec.lastBody = nb; continue; }catch(e){ logErr("rebind", e); } }
        }
        delete remotes[k];                       // the player left the machine by himself (respawn key ...)
    }
}

function serverCommand(pl, text){
    if(pl == null || pl.team() == null || !Vars.state.isGame()) return;
    var f = String(text).split("|");
    var c = f[0];
    ctxPl = pl;
    try{
        if(c == "poss"){
            startRemote(pl, pickMachineFor(pl, Number(f[1]), Number(f[2])));
        }else if(c == "leave"){
            var r = remoteOfPlayer(pl);
            if(r != null) releaseRemote(r, false, false);
        }else if(c == "need"){
            var nmx = machines.filter(x => x.id == Number(f[1]))[0];
            if(nmx != null && nmx.mode == "fly" && nmx.parts.length > 0){
                var sgx = netSigOf(nmx);
                netSig[nmx.id] = sgx;
                var txt = netEncodeStruct(nmx, sgx);
                if(txt.length <= 30000) Packages.mindustry.gen.Call.clientPacketReliable(pl.con, "mb-struct", txt);
            }
        }else if(c == "build"){
            if(bmRemote[pl.id] === true) exitBuildMode(pl); else enterBuildMode(pickMachineFor(pl, Number(f[1]), Number(f[2])), pl);
            saveDirty = true;
        }else if(c == "park"){
            var pr = remoteOfPlayer(pl);
            parkMachine(pr != null ? pr.m : nearestMachine(pl.x, pl.y, pl.team()));
        }else if(c == "front"){
            if(!bmOfPlayer(pl)) return;
            var wx = Number(f[2]), wy = Number(f[3]), best = null, bd = 1e12, rr = remoteOfPlayer(pl);
            if(rr != null && rr.m.mode == "land") best = rr.m;
            landedMachines().forEach(x => {
                if(best != null || x.team.id != pl.team().id) return;
                var pos = machinePos(x), d = Mathf.dst2(pos[0], pos[1], wx, wy);
                if(d < bd){ bd = d; best = x; }
            });
            if(best == null){ say("mb.msg.nomachine"); return; }
            turnFront(best, Number(f[1]) < 0 ? -1 : 1);
        }else if(c == "layer"){
            if(!bmOfPlayer(pl)) return;
            var t = Vars.world.tile(Number(f[1]), Number(f[2]));
            toggleLayer(t == null ? null : t.build);
        }else if(c == "area"){
            if(!bmOfPlayer(pl)) return;
            var st = Number(f[5]) >= 0 ? Vars.world.tile(Number(f[5]), Number(f[6] === undefined ? f[5] : f[6])) : null;
            finishLayerSelection(Number(f[1]), Number(f[2]), Number(f[3]), Number(f[4]), st == null ? null : st.build);
        }else if(c == "fp"){
            var blk = Vars.content.getByName(ContentType.block, f[1]);
            if(blk == null || !bmOfPlayer(pl)) return;
            var bx = Number(f[2]), by = Number(f[3]), brot = Number(f[4]) | 0;
            if(!freePlaceOk(blk, bx, by, brot)) return;
            if(!hasStartResources(blk, pl.team())){ say("mb.msg.freeres"); return; }
            beginFreePlace(blk, bx, by, brot);
        }else if(c == "shipcfg"){
            // client set resource on a ship-control block
            var t = Vars.world.tile(Number(f[1]), Number(f[2]));
            var b = t == null ? null : t.build;
            if(b == null || !isShipControl(b) || b.team != pl.team()) return;
            var code = f[3] === undefined ? "" : f[3];
            shipCfg[b.id] = code === "" ? null : shipFromCode(code);
            saveDirty = true;
        }else if(c == "shipopt"){
            // client set a ship-control option (mode, full%, route, toggles...)
            var t2 = Vars.world.tile(Number(f[1]), Number(f[2]));
            var b2 = t2 == null ? null : t2.build;
            if(b2 == null || !isShipControl(b2) || b2.team != pl.team()) return;
            var key = f[3], raw = f[4];
            if(key == null) return;
            var val;
            if(raw === "1" || raw === "0") val = raw === "1";
            else val = Number(raw);
            if(key === "full" || key === "restart") val = Mathf.clamp(val, 0, 1);
            if(key === "dx" || key === "dy" || key === "sx" || key === "sy") val = Math.round(val);
            shipOptOf(b2)[key] = val;
            saveDirty = true;
        }
    }catch(e){
        logErr("serverCommand " + c, e);
    }finally{
        ctxPl = null;
    }
}

var netSrvDone = false;
/** the handlers of the server are installed at the first frame (the net objects may not exist yet when the script loads) */
function installServerHandlers(){
    if(netSrvDone || Vars.netServer == null) return;
    try{
        Vars.netServer.addPacketHandler("mb-cmd", new Packages.arc.func.Cons2({get: function(pl, text){ try{ serverCommand(pl, text); }catch(e){ logErr("mb-cmd", e); } }}));
        Vars.netServer.addPacketHandler("mb-in", new Packages.arc.func.Cons2({get: function(pl, text){
            try{
                var r = remoteOfPlayer(pl);
                if(r == null) return;
                var f = String(text).split("|");
                r.ix = Number(f[0]) || 0; r.iy = Number(f[1]) || 0; r.spin = Number(f[2]) || 0;
                r.last = Time.globalTime;
            }catch(e){ logErr("mb-in", e); }
        }}));
        netSrvDone = true;
    }catch(e){
        logErr("server handlers", e);
    }
}

/** client -> server */
/** a client got the pose of a machine whose picture it does not have (it joined, or a packet was lost): ask the host for it */
function netRequestStruct(id){
    var now = Time.globalTime;
    if(netNeedAt[id] != null && now - netNeedAt[id] < 120) return;
    netNeedAt[id] = now;
    netCmd("need|" + id);
}

/** an effect of the host that the clients must see too: "kind,x,y,arg" */
function netFx(kind, x, y, arg){
    if(!isNetHost()) return;
    netSend(true, "mb-fx", kind + "," + x.toFixed(1) + "," + y.toFixed(1) + "," + (arg === undefined ? 0 : Math.round(arg)));
}

function netCmd(text){
    try{ Packages.mindustry.gen.Call.serverPacketReliable("mb-cmd", text); }catch(e){ logErr("netCmd", e); }
}
/** where the cursor points (the middle of the screen on a phone) */
function aimXY(){
    if(Vars.mobile || Core.input == null) return [Core.camera.position.x, Core.camera.position.y];
    return [Core.input.mouseWorldX(), Core.input.mouseWorldY()];
}

/** what a machine is made of, as a short text: when it changes the clients get the picture of the machine again */
function netSigOf(m){
    var h = 7;
    for(var i = 0; i < m.parts.length; i++){
        var b = m.parts[i];
        h = (h * 31 + b.block.id * 7 + b.tile.x * 13 + b.tile.y + (b.dead ? 1 : 0)) | 0;
    }
    return m.parts.length + "_" + h;
}

/** "id|team|sig|name,x,y,rot;name,x,y,rot;..." : x, y are the place of the block in the frame of the machine (world units) */
function netEncodeStruct(m, sig){
    var out = [];
    for(var i = 0; i < m.parts.length; i++){
        var b = m.parts[i];
        if(b.dead) continue;
        out.push(b.block.name + "," + Math.round((b.tile.drawx() - m.ref[0] * TS) * 10) / 10 + "," +
                 Math.round((b.tile.drawy() - m.ref[1] * TS) * 10) / 10 + "," + b.rotation);
    }
    return m.id + "|" + m.team.id + "|" + sig + "|" + out.join(";") + "|" + m.x.toFixed(1) + "," + m.y.toFixed(1) + "," + m.ang.toFixed(1);
}

/** "id|sig|T3:rot:heat;F7:radius;..." : what moves in a machine: the aim and the heat of the turrets (heat in percent) and the
 *  radius of a shield (0: it is down). The number before the colon is the place of the block in the picture above. */
function netEncodeState(m, sig){
    var out = [], idx = 0;
    for(var i = 0; i < m.parts.length; i++){
        var b = m.parts[i];
        if(b.dead) continue;
        if(isTurret(b)){
            // angle relative to the hull so the client can draw: nm.ang + trot - 90
            var rel = Math.round(b.rotation - m.ang);
            while(rel < 0) rel += 360;
            while(rel >= 360) rel -= 360;
            out.push("T" + idx + ":" + rel + ":" + Math.round(Mathf.clamp(numOr(b.heat, 0), 0, 1) * 100));
        }else if(isForceProjector(b)){
            var r = 0;
            try{ r = b.broken ? 0 : Number(b.realRadius()); }catch(e){ r = 0; }
            out.push("F" + idx + ":" + Math.round(r * 10) / 10);
        }else if(isReactorBooster(b)){
            var rs = bstates[b.id];
            var hp = rs === undefined ? 0 : Math.round(Mathf.clamp(rs.overheat / REACTOR_HEAT_TICKS, 0, 1) * 100);
            if(hp > 1) out.push("H" + idx + ":" + hp);
        }
        idx++;
    }
    return m.id + "|" + sig + "|" + out.join(";");
}

function isNetHost(){
    // Claj / relay: treat as host when this side is the server, or active net and not a pure client
    try{
        if(Vars.net.server()) return true;
        if(Vars.net.active() && !Vars.net.client()) return true;
    }catch(e){}
    return false;
}

function netSend(reliable, type, text){
    if(text.length > 30000){
        if(!netWarned){ netWarned = true; Log.warn("[mb] a machine is too big to be shown to the other players"); }
        return;
    }
    var C = Packages.mindustry.gen.Call;
    var sent = 0;
    // Claj-safe: send to each remote connection explicitly
    try{
        Groups.player.each(cons(pl => {
            if(pl == null || pl.con == null) return;
            if(Vars.player != null && pl == Vars.player) return;
            try{
                if(reliable) C.clientPacketReliable(pl.con, type, text);
                else C.clientPacketUnreliable(pl.con, type, text);
                sent++;
            }catch(e1){ logErr("netSend con " + type, e1); }
        }));
    }catch(eG){ logErr("netSend players", eG); }
    // fallback broadcast (vanilla host without Claj)
    if(sent == 0){
        try{
            if(reliable) C.clientPacketReliable(type, text); else C.clientPacketUnreliable(type, text);
        }catch(eB){ logErr("netSend broadcast " + type, eB); }
    }
}

/** the setting of a block as a short text for the clients ("" when it has none) */
function cfgCode(b){
    try{
        var c = configToAbs(b);
        if(c == null) return "";
        if(c.kind == 4) return "i~" + c.item;
        if(c.kind == 5) return "l~" + c.liquid;
        if(c.kind == 6){
            if(c.val === true || c.val === false) return "b~" + (c.val ? 1 : 0);
            if(typeof c.val == "number") return "n~" + c.val;
            return "";
        }
        if((c.kind == 1 || c.kind == 2) && c.abs != null && c.abs.length > 0) return "p" + c.kind + "~" + c.abs.join("^");
    }catch(e){ /* no setting then */ }
    return "";
}

/** the final state of every tile the mod changed since the last frame: "x,y,blockId,teamId,rot;..." (blockId -1: empty) */
function netFlushTiles(){
    var keys = Object.keys(netTileQ);
    if(keys.length == 0) return;
    netTileQ = {};
    var airs = [], sets = [];
    for(var i = 0; i < keys.length; i++){
        var t = Vars.world.tile(+keys[i]);
        if(t == null) continue;
        var b = t.build;
        if(b != null){
            if(b.tile !== t) continue;                       // a covered tile of a bigger block: its origin is sent
            sets.push(t.x + "," + t.y + "," + b.block.id + "," + b.team.id + "," + b.rotation + "," + cfgCode(b));
        }else if(t.block() == Blocks.air){
            airs.push(t.x + "," + t.y + ",-1,0,0");
        }
    }
    var all = airs.concat(sets);                              // empty tiles first: a block may stand where another one was
    for(var k = 0; k < all.length; k += 500){
        netSend(true, "mb-tiles", all.slice(k, k + 500).join(";"));
    }
}

function netHostTick(){
    if(!isNetHost() || !Vars.state.isGame() || Vars.state.isPaused()) return;
    var others = 0;
    Groups.player.each(cons(pl => { if(pl != Vars.player) others++; }));
    if(others == 0){ netTileQ = {}; return; }
    try{ netFlushTiles(); }catch(eT){ logErr("net tiles", eT); }                       // nobody to send it to: no encoding work (machines that are new to a joiner come every 5 s)
    // every player learns only about his own build mode
    Groups.player.each(cons(bp => {
        if(bp === Vars.player) return;
        var on = bmRemote[bp.id] === true;
        if(netBmSent[bp.id] !== on || netStructTimer <= 0){
            netBmSent[bp.id] = on;
            try{ Packages.mindustry.gen.Call.clientPacketReliable(bp.con, "mb-bm", on ? "1" : "0"); }catch(eB){ logErr("mb-bm", eB); }
        }
    }));
    netMeTimer -= Time.delta;
    if(netMeTimer <= 0){
        netMeTimer = 4;
        for(var rk in remotes){
            var rr = remotes[rk];
            try{
                var mp = machinePos(rr.m);
                Packages.mindustry.gen.Call.clientPacketUnreliable(rr.pl.con, "mb-me", mp[0].toFixed(1) + "," + mp[1].toFixed(1));
            }catch(e){ logErr("mb-me", e); }
        }
    }
    netPoseTimer -= Time.delta;
    netStructTimer -= Time.delta;
    netStateTimer -= Time.delta;
    var flying = flyingMachines().filter(m => m.parts.length > 0);
    var all = netStructTimer <= 0;
    if(all) netStructTimer = 300;                 // again every 5 s: a player who joins later learns it too
    var sendState = netStateTimer <= 0;
    if(sendState) netStateTimer = 10;             // six times a second
    flying.forEach(m => {
        var sig = netSigOf(m);
        if(all || netSig[m.id] !== sig){
            netSig[m.id] = sig;
            netSend(true, "mb-struct", netEncodeStruct(m, sig));
        }
        if(sendState) netSend(false, "mb-state", netEncodeState(m, sig));
    });
    netRelPoseTimer -= Time.delta;
    if(netPoseTimer <= 0 && flying.length > 0){
        netPoseTimer = 2;                         // ~30 times a second: less teleport on clients
        var stamp = Math.floor(Time.globalTime);
        var poseText = flying.map(m => m.id + "," + m.x.toFixed(1) + "," + m.y.toFixed(1) + "," + m.ang.toFixed(1) + "," +
            (m.vx || 0).toFixed(2) + "," + (m.vy || 0).toFixed(2) + "," + (m.fall != null ? Math.max(0, m.fall.h).toFixed(2) : "1") + "," + stamp).join(";");
        netSend(false, "mb-pose", poseText);
        // the unreliable channel (UDP) may not get through (a relay host, a firewall): then the machine would never be seen,
        // so the same pose goes also by the reliable one, 5 times a second (the stamp keeps an old one from beating a new one)
        if(netRelPoseTimer <= 0){
            netRelPoseTimer = 12;
            netSend(true, "mb-pose", poseText);
        }
    }
}

// ---------------------------------------------------------------------------
//  mass drivers. A driver finds its target through the real world (world.build(link)), which a flying machine's blocks are not
//  part of, so in flight a driver neither found a target nor could be one. The game's handshake (sender waits, receiver
//  accepts and turns, sender fires) is done here instead, for the two cases the game cannot see:
//    - a flying driver with a link shoots at the ground driver it was linked to;
//    - a ground driver whose link points to the place where a driver now flying used to stand shoots at that driver.
//  The shot itself is the game's own bolt with its own item load, so the picture and the delivery are the usual ones.
// ---------------------------------------------------------------------------
var MassDriverClass = Packages.mindustry.world.blocks.distribution.MassDriver;
var mdPos = {};            // building id -> the tile position (what a link holds) where a driver stood the last time it was seen on the ground
var mdGround = [];
var mdTimer = 0;

function mdLinked(p){
    try{ return p.block instanceof MassDriverClass && p.link >= 0; }catch(e){ return false; }
}

var mdFlyTargets = {};     // link positions that now lead to a flying driver (refreshed every tick in mdTick)

// The game's driver takes items from conveyors only while its link is valid (the target is found in the world and in range). A driver
// in flight cannot see its target (the real world is not the pocket it lives in), and a ground driver whose target has flown away
// cannot either: both stayed empty, so nothing was ever sent. Here a driver that has a link accepts items, and one that is linked to
// a flying driver does not empty itself into its neighbours.
try{
    var MDBuildClass = Packages.mindustry.world.blocks.distribution.MassDriver$MassDriverBuild;
    var mdBlockV = Blocks.massDriver;
    mdBlockV.buildType = prov(() => extend(MDBuildClass, mdBlockV, {
        acceptItem(source, item){
            return this.items.total() < this.block.itemCapacity && this.link != -1;
        },
        canDump(to, item){
            return !(this.link != -1 && mdFlyTargets[this.link] === true);
        }
    }));
}catch(eMdb){
    Log.err("[mb] mass driver override failed: " + eMdb);
}

var DriverDataClass = Packages.mindustry.world.blocks.distribution.MassDriver$DriverBulletData;
var mdBolts = [];          // bolts that this mod fired: [bullet, data]

function isDriverBolt(b){
    try{ return b.data instanceof DriverDataClass; }catch(e){ return false; }
}

/** A bolt goes to the place where the receiver is NOW: both drivers may fly, and the game's own bolt only flies straight and is
 *  received only when it is exactly on the line sender -> receiver (which a moving machine breaks). So the bolt is steered at the
 *  receiver and handed over as soon as it is close. */
function mdSteerBolts(){
    if(mdBolts.length == 0) return;
    var keep = [];
    for(var i = 0; i < mdBolts.length; i++){
        var e = mdBolts[i], b = e[0], data = e[1];
        try{
            if(b.isAdded && !b.isAdded()) continue;       // gone (received, or flew out)
            var to = data.to;
            if(to == null || to.dead) continue;            // the game's bolt flies on until it despawns (dead is a boolean field)
            var d = Mathf.dst(b.x, b.y, to.x, to.y);
            if(d <= 8){
                to.handlePayload(b, data);
                continue;
            }
            var sp = b.vel.len();
            if(sp > 0.01) b.vel.setAngle(Angles.angle(b.x, b.y, to.x, to.y));
            keep.push(e);
        }catch(err){ logErr("mdSteerBolts", err); }
    }
    mdBolts = keep;
}

/** the game's bolt, with the load of the sender, from the sender to the receiver */
function mdFire(s, r, angle){
    var blk = s.block;
    var DBD = Packages.mindustry.world.blocks.distribution.MassDriver$DriverBulletData;
    var data = new DBD();
    data.from = s;
    data.to = r;
    var items = Vars.content.items(), used = 0;
    for(var i = 0; i < items.size; i++){
        var it = items.get(i);
        var n = Math.min(s.items.get(it), blk.itemCapacity - used);
        data.items[i] = n;
        used += n;
        if(n > 0) s.items.remove(it, n);
    }
    var sx0 = s.x, sy0 = s.y;
    var bx = s.x + Angles.trnsx(angle, blk.translation), by = s.y + Angles.trnsy(angle, blk.translation);
    // (the game passes the speed and the lifetime of the DRIVER as scales: the bolt itself has speed 1 and lifetime 1, so with 1 / 1
    //  it was gone at once and its load with it)
    var ts = numOr(s.timeScale, 1);
    var bolt = blk.bullet.create(s, s.team, bx, by, angle, used / 2, numOr(blk.bulletSpeed, 5.5) * ts, numOr(blk.bulletLifetime, 200) / ts, data);
    if(bolt != null) mdBolts.push([bolt, data]);
    try{
        blk.shootEffect.at(bx, by, angle);
        blk.smokeEffect.at(bx, by, angle);
        Effect.shake(blk.shake, blk.shake, s);
        blk.shootSound.at(sx0, sy0, 1 + Mathf.range(0.2), blk.shootSoundVolume);
    }catch(e){ /* only the looks */ }
    s.reloadCounter = 1;
}

/** the handshake of the game for one pair: in range, both powered, enough to send and room to receive, the sender turned to
 *  the target, reloaded; then it fires */
var mdWhyAt = {};
/** why a driver did not do anything (to the log, rarely): "[mb] mass driver ..." */
function mdWhy(s, text){
    var t = mdWhyAt[s.id];
    if(t !== undefined && Time.globalTime - t < 600) return;
    mdWhyAt[s.id] = Time.globalTime;
    Log.info("[mb] mass driver at " + s.tile.x + "," + s.tile.y + " waits: " + text);
}

function mdTrySend(s, r, flies){
    var blk = s.block;
    var minD = numOr(blk.minDistribute, 10);
    var sx = s.x, sy = s.y, rx = r.x, ry = r.y;
    if(Mathf.dst(sx, sy, rx, ry) > numOr(blk.range, 440)){ mdWhy(s, "the partner is out of range"); return; }
    if(flies) s.reloadCounter = Mathf.clamp(numOr(s.reloadCounter, 0) - s.edelta() / numOr(blk.reload, 100));   // the game does it for a ground driver itself
    var angle = Angles.angle(sx, sy, rx, ry);
    if(numOr(s.efficiency, 0) <= 0){ mdWhy(s, "no power"); return; }
    // like the game: a linked and powered driver faces its partner, with or without cargo
    s.rotation = Angles.moveToward(s.rotation, angle, numOr(blk.rotateSpeed, 5) * s.efficiency);
    if(numOr(r.efficiency, 0) <= 0){ mdWhy(s, "the receiver has no power"); return; }
    if(s.items.total() < minD) return;
    if(r.block.itemCapacity - r.items.total() < minD) return;
    r.rotation = Angles.moveToward(r.rotation, angle + 180, numOr(r.block.rotateSpeed, 5) * r.efficiency);
    if(s.reloadCounter > 0.0001) return;
    if(!Angles.near(s.rotation, angle, 2) || !Angles.near(r.rotation, angle + 180, 2)) return;   // both turned, as in the game
    mdFire(s, r, angle);
}

function mdTick(delta){
    mdSteerBolts();
    var MD = MassDriverClass;
    var flyDrivers = [], flyIds = {};
    machines.forEach(m => {
        if(m.mode != "fly") return;
        m.parts.forEach(b => {
            if(!b.dead && b.block instanceof MD){
                var e = {m: m, p: b};
                flyDrivers.push(e);
                flyIds[b.id] = e;
            }
        });
    });
    // the ground drivers: where they stand is remembered (a link to a driver that has flown away still holds that place)
    mdTimer -= delta;
    if(mdTimer <= 0){
        mdTimer = 20;
        mdGround = [];
        Groups.build.each(b => b.block instanceof MD, b => {
            if(flyIds[b.id] !== undefined || b.tile == null || b.tile.build !== b) return;
            mdPos[b.id] = b.tile.pos();
            mdGround.push(b);
        });
    }
    mdFlyTargets = {};
    for(var fi = 0; fi < flyDrivers.length; fi++){
        var fpos = mdPos[flyDrivers[fi].p.id];
        if(fpos !== undefined) mdFlyTargets[fpos] = true;
    }
    if(flyDrivers.length == 0) return;
    var byPos = (pos, exceptId) => {
        for(var i = 0; i < flyDrivers.length; i++){
            var e = flyDrivers[i];
            if(e.p.id !== exceptId && mdPos[e.p.id] === pos) return e;
        }
        return null;
    };
    // a flying driver with a link shoots at the ground driver it was linked to (or at another flying one)
    flyDrivers.forEach(e => {
        var p = e.p;
        if(!mdLinked(p)) return;
        var d = Vars.world.build(p.link);
        if(d != null){
            if(d.block instanceof MD && d.team == p.team && flyIds[d.id] === undefined && d.isValid()) mdTrySend(p, d, true);
        }else{
            var t = byPos(p.link, p.id);
            if(t != null && t.p.team == p.team) mdTrySend(p, t.p, true);
        }
    });
    // a ground driver whose link leads to a driver that now flies shoots at it
    mdGround.forEach(g => {
        if(!g.isValid() || g.link < 0 || g.tile == null || g.tile.build !== g) return;
        if(Vars.world.build(g.link) != null) return;                  // an ordinary target, the game does it
        var t = byPos(g.link, -1);
        if(t != null && t.p.team == g.team) mdTrySend(g, t.p, false);
    });
}

/** keys of the local player: G (build mode), Y (drive / layers), R (front); the same on the host and on a client */
function handleKeys(){
    var typing = Core.scene.hasKeyboard() || Core.scene.hasDialog();
    var keysFree = !typing && !Vars.control.input.commandMode;
    if(keysFree){
        if(Core.input.keyTap(KeyCode.g)) toggleBuild();
        else if(Core.input.keyTap(KeyCode.y)){
            if(buildMode) startLayerDrag();         // the block / square is moved when Y is released
            else togglePossess();
        }
        else if(buildMode && Core.input.keyTap(KeyCode.r)) rotateFrontKey();
    }
    updateLayerDrag(!keysFree);
    try{ trackSchematic(); }catch(e){ logErr("trackSchematic", e); }
}

var netInTimer = 0, netInLast = "";
/** a client: keys, the stick while driving, the place of the driven body (the server sends it) */
function clientTick(){
    // never keep a host-side registry on a pure client (stale land machines = phantom / undismantleable mess)
    if(machines.length > 0 || Object.keys(cellIndex).length > 0){
        machines = [];
        cellIndex = {};
        partIndex = {};
        bstates = {};
        loose = {};
        poss = null;
    }
    if(!Vars.headless && !Vars.state.isPaused()){
        handleKeys();
        var u = Vars.player == null ? null : Vars.player.unit();
        netDriving = u != null && u.type == driverType;
        if(netDriving){
            netInTimer -= Time.delta;
            var typing = Core.scene.hasKeyboard() || Core.scene.hasDialog();
            var inp = readInput(), spin = 0;
            if(!typing) spin = (Core.input.keyDown(KeyCode.q) ? 1 : 0) - (Core.input.keyDown(KeyCode.e) ? 1 : 0);
            var msg = inp[0].toFixed(2) + "|" + inp[1].toFixed(2) + "|" + spin;
            if(msg !== netInLast || netInTimer <= 0){
                netInLast = msg; netInTimer = 6;
                try{ Packages.mindustry.gen.Call.serverPacketUnreliable("mb-in", msg); }catch(e){ logErr("mb-in send", e); }
            }
            if(netMe != null){
                var f = 1 - Math.exp(-Time.delta * 0.3);
                u.set(u.x + (netMe[0] - u.x) * f, u.y + (netMe[1] - u.y) * f);
                u.vel.setZero();
            }
        }else{
            netInLast = "";
            netMe = null;
        }
    }
    padX = 0; padY = 0;
}
var netMe = null;

runEvent(Trigger.update, () => {
    restoreBodies();                    // a frame that was cut short must not leave the bodies at half size
    restoreBeamCuts();                  // ... nor the beams shortened
    if(!Vars.state.isGame()) return;
    if(Vars.net.client()){
        try{ clientTick(); }catch(e){ logErr("clientTick", e); }
        return;
    }
    installServerHandlers();
    try{ netHostTick(); }catch(e){ logErr("netHostTick", e); }
    if(!Vars.headless && !Vars.state.isPaused()){
        handleKeys();
    }else if(layerDrag != null){
        layerDrag = null;                               // the game is paused: the square is dropped
    }
    if(!Vars.state.isPaused()){
        checkPossession();
        try{ remoteTick(); }catch(e){ logErr("remoteTick", e); }
        try{ processOrders(); }catch(e){ logErr("processOrders", e); }
        try{ enforceNoBuild(); }catch(e){ logErr("enforceNoBuild", e); }
        if(poss != null && poss.m.mode == "land") driveLanded(poss.m, Time.delta);
        for(var rk in remotes){
            var rr = remotes[rk];
            if(rr.m.mode != "land") continue;
            ctxPl = rr.pl;
            try{ driveLanded(rr.m, Time.delta, remoteInput(rr)); }catch(e){ logErr("driveLanded remote", e); }
            ctxPl = null;
        }
        var fl = flyingMachines();
        fl.forEach(m => { if(machines.indexOf(m) >= 0) flyStep(m, Time.delta); });
        try{ collideMachines(); }catch(e){ logErr("collideMachines", e); }
        fl.forEach(m => { if(machines.indexOf(m) >= 0) flyLogic(m, Time.delta); });
        inheritMachineVelocity();       // bullets fired by the guns just now take the speed of their machine
        scanBullets();
        try{ mdTick(Time.delta); }catch(e){ logErr("mdTick", e); }
        // the touch pad is filled by the UI AFTER this update, so it may only be cleared once the machines have read it
        // (clearing it before flyStep meant a flying machine always read zero: it could not be steered on a phone)
        padX = 0; padY = 0;
    }
    processDirty();
    if(saveDirty) saveRegistry();
});

runEvent(Trigger.afterGameUpdate, () => {
    machines.forEach(m => { if(m.body != null) keepBody(m); });
    // shots with a delay (salvos), fragments of bullets ... appear during the game update, after the guns were handled
    if(Vars.state.isGame() && !Vars.state.isPaused() && !Vars.net.client()) inheritMachineVelocity();
});

// expose a small debug API for the console: js MB.status()
var MB = {
    machines: () => machines,
    create: b => { buildMode = true; return createMachine(b); },
    takeOff: m => takeOff(m),
    land: m => { buildMode = true; return landMachine(m); },
    enterBuild: m => enterBuildMode(m),
    exitBuild: () => exitBuildMode(),
    toggleLayer: b => { buildMode = true; toggleLayer(b); },
    toggleLayerArea: (blds, dir) => { buildMode = true; toggleLayerArea(blds, dir || layerDirection(blds, null)); },
    buildingsInRect: (x0, y0, x1, y1, team) => buildingsInRect(x0, y0, x1, y1, team == undefined ? null : team),
    front: (m, f) => { if(f !== undefined){ m.front = f & 3; saveDirty = true; } return frontIndex(m); },
    turnFront: (m, steps) => turnFront(m, steps),
    step: (m, d) => stepMachine(m, d),
    plan: (m, dx, dy) => planMove(m, dx, dy),
    stats: m => machineStats(m),
    reconcile: (m, r) => reconcile(m, r),
    flyReconcile: m => flyReconcile(m),
    refreshOre: m => refreshOre(m),
    damagePart: (m, p, a) => damagePart(m, p, a),
    partAtWorld: (m, x, y) => partAtWorld(m, x, y),
    destroyMachine: m => destroyMachine(m),
    setAng: (m, a) => setAng(m, a),
    fire: p => { testFire = p; },
    possess: m => { poss = m == null ? null : {m: m}; },
    input: v => { testInput = v; },
    save: () => saveRegistry(),
    load: () => loadRegistry(),
    rocketBooster: rocketBooster,
    energyBooster: energyBooster,
    fuelBooster: fuelBooster,
    speed: m => flightSpeed(m),
    mass: m => machineMass(m),
    energy: m => machineEnergy(m),
    momentum: m => machineMomentum(m),
    collide: () => collideMachines(),
    // autopilot of the ship control blocks: which resources the machine is fetching ({key: true}) and where it goes
    ship: m => ({latch: m.shipLatch, target: m.shipGoal == null ? null : [m.shipGoal.tx, m.shipGoal.ty], goal: shipGoal(m)}),
    stock: (m, r) => shipStock(m, r),
    boosterStates: () => bstates,
    driver: driverType,
    buildMode: () => buildMode,
    tick: () => { processDirty(); },
    status: () => machines.map(m => "#" + m.id + " " + m.mode + " ang=" + (m.ang | 0) + " pos=" + (m.x | 0) + "," + (m.y | 0) + " cells=" + countKeys(m.cells) + " parts=" + m.parts.length + " pending=" + countKeys(m.pending) + " loose=" + countKeys(loose) + " " + JSON.stringify(machineStats(m))).join("\n")
};
try{
    Packages.rhino.ScriptableObject.putProperty(Vars.mods.scripts.scope, "MB", MB);
}catch(e){
    Log.err("[mb] debug api not exposed: " + e);
}

// ---------------------------------------------------------------------------
//  client only: drawing, HUD, settings
// ---------------------------------------------------------------------------
if(!Vars.headless){
    var GRID = Color.valueOf("7fd0ff");
    var BLUE = Color.valueOf("2a5bff");

    // ---- the darkness of the map ("inner shadows" of the blocks) -------------------------------------------------
    // The game draws the darkness - the shadow inside thick clusters of walls, at the border of the map and of the
    // playable area - as one more layer, Layer.darkness: over the ground, the blocks and the ground units, but under
    // bullets, effects and flying units. A machine flies, so it must be over that layer too, otherwise the walls it
    // flies over (or stands next to) shade it. Two cases:
    //  * a flying machine is drawn by the mod: it simply goes just over Layer.darkness (and still under bullets,
    //    effects and flying units). Its shadow stays under the darkness, like the shadow of any flying unit;
    //  * the blocks of a landed machine (build mode) are drawn by the game itself, far under that layer: where such
    //    a machine lies in the darkness the mod draws it once more, just over the layer (with its marks of the build
    //    mode: the outline, the grid, the front arrow).
    function layerOr(name, fallback){
        var v = Layer[name];
        return v === undefined || v === null || isNaN(+v) ? fallback : +v;
    }
    var DARK_Z = layerOr("darkness", -1);                                  // -1: this game version has no such layer
    var BODY_Z = DARK_Z >= 0 ? Math.max(Layer.groundUnit + 1, DARK_Z + 1) : Layer.groundUnit + 1;
    var SEL_Z = DARK_Z >= 0 ? BODY_Z + 0.4 : Layer.blockOver + 3;          // the square of Y: a marker, over the machines

    var darkCache = {};      // real tile -> is there darkness over it (or right next to it)?
    var darkEpoch = 0;       // +1 whenever darkCache is thrown away: caches that depend on it are made again
    var darkSig = "", darkSigStamp = -1000;

    /** the darkness depends on the map and on the rules (map area, border): forget what was found when they change */
    function refreshDarkness(){
        var now = Time.globalTime;
        if(now >= darkSigStamp && now - darkSigStamp < 30) return;
        darkSigStamp = now;
        var r = Vars.state.rules;
        var sig = Vars.world.width() + "x" + Vars.world.height() + ":" + r.borderDarkness + ":" + r.limitMapArea + ":"
            + r.limitX + "," + r.limitY + "," + r.limitWidth + "," + r.limitHeight;
        if(sig !== darkSig){
            darkSig = sig;
            darkCache = {};
            darkEpoch++;
        }
    }

    /** does the darkness lie over this tile? (a tile next to a dark one counts: the darkness is smoothed over the edge) */
    function darkAt(x, y){
        var key = (x + 8) * 16384 + (y + 8);
        var v = darkCache[key];
        if(v !== undefined) return v;
        v = false;
        for(var dx = -1; dx <= 1 && !v; dx++){
            for(var dy = -1; dy <= 1; dy++){
                if(Vars.world.getDarkness(x + dx, y + dy) > 0){ v = true; break; }
            }
        }
        darkCache[key] = v;
        return v;
    }

    /** true when a landed machine lies (even partly) in the darkness: it is then drawn over it, together with its marks.
     *  Looked up again only when the cells of the machines or the darkness changed. */
    function landedLift(m){
        if(DARK_Z < 0) return false;
        if(m.liftVer === layoutVersion && m.liftEpoch === darkEpoch) return m.lift === true;
        m.liftVer = layoutVersion;
        m.liftEpoch = darkEpoch;
        var lift = false, x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
        for(var k in m.cells){
            var x = Point2.x(+k), y = Point2.y(+k);
            if(x < x0) x0 = x;
            if(x > x1) x1 = x;
            if(y < y0) y0 = y;
            if(y > y1) y1 = y;
            if(!lift && darkAt(x, y)) lift = true;
        }
        m.lift = lift;
        m.bbox = [x0, y0, x1, y1];
        return lift;
    }

    /** the blocks of a landed machine: looked up again when the machines changed (and now and then, to be safe) */
    function landedMembers(m){
        var now = Time.globalTime;
        if(m.memList === undefined || m.memVer !== layoutVersion || now < m.memStamp || now - m.memStamp > 20){
            m.memStamp = now;
            m.memVer = layoutVersion;
            m.memList = membersOf(m.cells, m.team);
        }
        return m.memList;
    }

    /** draws the blocks of a landed machine once more, over the darkness (the game has drawn them under it already) */
    function drawLanded(m){
        var list = landedMembers(m);
        var cam = Core.camera;
        Draw.draw(BODY_Z, () => {
            try{
                var heads = [];
                withBlendFlush(() => {
                    for(var i = 0; i < list.length; i++){
                        var b = list[i];
                        if(b.tile == null || b.tile.build !== b || isConstructing(b)) continue;   // gone / still being built
                        var reach = b.block.size * TS + 16;
                        if(Math.abs(b.x - cam.position.x) > cam.width / 2 + reach || Math.abs(b.y - cam.position.y) > cam.height / 2 + reach) continue;
                        if(isTurret(b)) heads.push(b); else drawPartSafe(b);
                    }
                });
                drawTurretsSorted(heads, t => drawPartSafe(t));
            }catch(e){
                logErr("drawLanded", e);
            }finally{
                Draw.reset();
            }
        });
    }

    /** the grid of the build mode over the cells of a machine that is drawn over the darkness (x0..y1: the visible tiles) */
    function drawLiftedGrid(m, x0, y0, x1, y1){
        var bb = m.bbox;
        if(bb == null) return;
        var ax0 = Math.max(bb[0], x0), ay0 = Math.max(bb[1], y0), ax1 = Math.min(bb[2], x1), ay1 = Math.min(bb[3], y1);
        if(ax0 > ax1 || ay0 > ay1) return;
        Draw.z(BODY_Z + 0.2);
        Lines.stroke(1);
        Draw.color(GRID, 0.28);
        for(var gx = ax0; gx <= ax1 + 1; gx++){
            Lines.line(gx * TS - TS / 2, ay0 * TS - TS / 2, gx * TS - TS / 2, (ay1 + 1) * TS - TS / 2);
        }
        for(var gy = ay0; gy <= ay1 + 1; gy++){
            Lines.line(ax0 * TS - TS / 2, gy * TS - TS / 2, (ax1 + 1) * TS - TS / 2, gy * TS - TS / 2);
        }
    }

    onEvent(WorldLoadEvent, () => { darkCache = {}; darkSig = ""; darkEpoch++; });
    onEvent(ResetEvent, () => { darkCache = {}; darkSig = ""; darkEpoch++; });

    /** draws the blocks of a flying machine: the batch transform turns the whole pocket into place */
    // the shadow of a flying machine: every block casts its own, exactly like a flying unit does
    var SHADOW_X = -12, SHADOW_Y = -13;      // vanilla offset of a unit shadow at full elevation

    function drawShadows(m){
        if(m.mode != "fly" || machines.indexOf(m) < 0) return;
        var c = Mathf.cosDeg(m.ang), s = Mathf.sinDeg(m.ang);
        var rx = m.ref[0] * TS, ry = m.ref[1] * TS;
        var white = Core.atlas.white();
        var hk = m.fall != null ? Math.max(0, m.fall.h) : 1;      // a falling machine is lower and lower: the shadow comes to it
        Draw.color(Pal.shadow);
        var parts = m.parts;
        for(var i = 0; i < parts.length; i++){
            var b = parts[i];
            if(b.dead) continue;
            var lx = b.tile.drawx() - rx, ly = b.tile.drawy() - ry;
            var size = b.block.size * TS;
            Draw.rect(white, m.x + lx * c - ly * s + SHADOW_X * hk, m.y + lx * s + ly * c + SHADOW_Y * hk, size, size, m.ang);
        }
        Draw.color();
    }

    // ---- turrets: the layers of a turret must be sorted again ------------------------------------------------
    // The game draws a turret in layers (base, shadow, head, outlines, parts that go UNDER the head, heat ...) and relies on
    // the sorting batch to put them in order by Draw.z. A machine is drawn inside one Draw.draw(BODY_Z) block, where the
    // batch no longer sorts: everything comes out in the order it was called. Parts that belong under the head landed on
    // top of it, and the shadow and base of one turret covered the head of its neighbour. So the turrets are drawn through
    // a batch of their own that sorts, all of them together, and that batch is flushed at once.
    var turretBatch = null;
    var turretSortOff = false;

    function turretSortOn(){
        return !turretSortOff && (Core.settings == null || Core.settings.getBool("mb-sorted-turrets", true));
    }

    // every Draw.* call goes through Core.batch (Draw.class is not usable in this scripting engine)
    function getDrawBatch(){
        return Core.batch;
    }

    function setDrawBatch(batch){
        Core.batch = batch;
    }

    // ---- glows: a block that draws something "additive" (the rim of a drill, the flame of a smelter ...) switches the blending
    // on, draws, switches it off. The game's batch applies the blending only when it is flushed, so inside a machine the
    // glow was drawn with the normal blending: dark and saturated instead of light. A batch of the same class whose change
    // of the blending first flushes what was drawn before makes every such block come out right. (Not for turrets: they
    // are sorted by layers, see below, and a flush in the middle would break the sorting.)
    var blendBatch = null, blendOff = false;

    function withBlendFlush(drawAll){
        if(blendOff){ drawAll(); return; }
        var main = null, swapped = false;
        try{
            if(blendBatch == null){
                var cls = getDrawBatch().getClass();
                var jc = Packages;
                String(cls.getName()).split(".").forEach(n => { jc = jc[n]; });
                blendBatch = extend(jc, {
                    setBlending(b){ this.flush(); this.super$setBlending(b); }
                });
            }
            var proj = new Mat().set(Draw.proj());
            var trans = new Mat().set(Draw.trans());
            Draw.flush();
            main = getDrawBatch();
            setDrawBatch(blendBatch);
            swapped = true;
            Draw.proj(proj);
            Draw.trans(trans);
            Draw.reset();
            drawAll();
            Draw.flush();
        }catch(e){
            logErr("withBlendFlush", e);
            blendOff = true;           // does not work in this game version: from now on the plain way
            blendBatch = null;
        }finally{
            if(swapped){
                try{ setDrawBatch(main); }catch(e2){ logErr("withBlendFlush restore", e2); }
            }
            Draw.reset();
        }
    }

    /** draws the turrets (drawOne(t) draws one of them) in the order of their layers */
    function drawTurretsSorted(list, drawOne){
        if(list.length == 0) return;
        if(!turretSortOn()){
            list.forEach(drawOne);
            return;
        }
        var main = null, swapped = false, begun = false, sortViaDraw = false;
        try{
            if(turretBatch == null){
                // the class of the game's own batch (its package differs between game versions, so it is not hardcoded)
                var cls = getDrawBatch().getClass();
                var ctors = cls.getDeclaredConstructors(), made = null;
                for(var ci = 0; ci < ctors.length && made == null; ci++){
                    if(ctors[ci].getParameterCount() == 0){
                        ctors[ci].setAccessible(true);
                        made = ctors[ci].newInstance();
                    }
                }
                if(made == null) throw "no default constructor in " + cls.getName();
                turretBatch = made;
            }
            var proj = new Mat().set(Draw.proj());
            var trans = new Mat().set(Draw.trans());
            Draw.flush();
            main = getDrawBatch();
            setDrawBatch(turretBatch);
            swapped = true;
            Draw.proj(proj);
            Draw.trans(trans);
            Draw.reset();
            // turn sorting on: older games have SortedSpriteBatch.sort(boolean), newer ones (a plain SpriteBatch) have Draw.sort(boolean)
            if(typeof turretBatch.sort === "function"){
                turretBatch.sort(true);
            }else{
                Draw.sort(true);
                sortViaDraw = true;
            }
            // old games need begin()/end() around the drawing, newer ones (plain SpriteBatch) do not have them at all
            var hasBegin = typeof turretBatch.begin === "function" && typeof turretBatch.end === "function";
            if(hasBegin){
                turretBatch.begin();
                begun = true;
            }
            list.forEach(t => {
                Draw.z(Layer.block);
                drawOne(t);
            });
            if(hasBegin){
                turretBatch.end();
                begun = false;
            }else{
                Draw.flush();      // flushes Core.batch, which is turretBatch right now
            }
        }catch(e){
            logErr("drawTurretsSorted", e);
            // something about this game version does not work: from now on turrets are drawn the old way
            turretSortOff = true;
            turretBatch = null;
        }finally{
            if(sortViaDraw){
                try{ Draw.sort(false); }catch(e3){ logErr("drawTurretsSorted sort off", e3); }
            }
            if(swapped){
                try{ setDrawBatch(main); }catch(e2){ logErr("drawTurretsSorted restore", e2); }
            }
            Draw.reset();
        }
    }

    /** draws one block of a flying machine the way the world renderer draws it (cached layer part + dynamic part).
     *  Not Building.payloadDraw(): some blocks override it with a plain static icon - the conveyor, for one, draws
     *  its unrotated icon (always facing the same way, no items on it). Conduits do not, which is why they looked fine. */
    function drawPart(b){
        var blk = b.block;
        var z = Draw.z();
        // old game versions have neither flag: the block is simply drawn by draw()
        if(blk.drawCached === true){
            Draw.z(blk.buildingCacheLayer.layer);
            b.drawCached();
        }
        if(blk.drawDynamic !== false){
            Draw.z(z);
            b.draw();
        }
        // damage: on the map the cracks of a damaged block are drawn by the world renderer (BlockRenderer calls
        // build.drawCracks() itself, they are not a part of draw()). A flying machine is not drawn by it, so it has to
        // do the same, otherwise the blocks never show that they are hurt. Drills and the like draw their own cracks
        // inside draw() and have an empty drawCracks(), so nothing is doubled.
        if(b.damaged()){
            Draw.z(Layer.blockCracks);
            b.drawCracks();
        }
        Draw.z(z);
    }

    /** one broken block must not stop the drawing of the whole machine */
    function drawPartSafe(b){
        try{
            drawPart(b);
        }catch(e){
            logErr("drawPart " + b.block.name, e);
            Draw.color();
        }
    }

    /** Parallax in flight. The block is drawn in the pocket frame, under the transform of the machine, but its aim (rotation) and
     *  the end of its beam (lastX / lastY, the target) are real world values: without the conversion the head turned by the angle
     *  of the machine too far and the beam ended in the wrong place. */
    function drawTractorPart(m, b){
        var tractor = isTractor(b);
        var r = b.rotation, lx = tractor ? b.lastX : 0, ly = tractor ? b.lastY : 0;
        try{
            b.rotation = r - m.ang;
            if(tractor && b.any){
                var q = toLocal(m, lx, ly);
                b.lastX = q[0]; b.lastY = q[1];
            }
            drawPartSafe(b);
        }catch(e){
            logErr("drawTractorPart", e);
        }finally{
            b.rotation = r;
            if(tractor){ b.lastX = lx; b.lastY = ly; }
        }
    }

    /** how strongly the heat glow of a turret of a flying machine is drawn (setting, percent of the normal glow) */
    function flyAnimShields(){
        try{ return !!Vars.renderer.animateShields; }catch(e){ return false; }
    }

    var heatRegions = {};
    function heatRegionOf(blk){
        var k = blk.name;
        if(heatRegions[k] !== undefined) return heatRegions[k];
        var r = null;
        try{
            // prefer the region the block itself loaded (works for Salvo and custom turrets)
            if(blk.heatRegion != null && blk.heatRegion.found && blk.heatRegion.found()) r = blk.heatRegion;
        }catch(e0){ r = null; }
        if(r == null){
            try{
                if(Core.atlas.has(k + "-heat")) r = Core.atlas.find(k + "-heat");
                else if(Core.atlas.has(blk.name + "-heat")) r = Core.atlas.find(blk.name + "-heat");
            }catch(e){ r = null; }
        }
        heatRegions[k] = r;
        return r;
    }

    function flyHeatScale(){
        return 1;
    }

    // ---- client: the flying machines of the host, drawn from what the host sends (see netHostTick) ----
    var netMachines = {};
    var netDbg = {struct: 0, pose: 0, tiles: 0, gone: 0, fx: 0, lastStruct: -1, lastPose: -1, lastTiles: -1};
    function netAgo(t){ return t < 0 ? "-" : (Math.round((Time.globalTime - t) / 6) / 10) + "s"; }
    /** every 5 s: if there are bodies of flying machines on the screen that have no picture (or no position) here, say so on the
     *  screen with the numbers of the packets received, so it is clear what does not get to the client */
    var netWatchAt = 0, netWatchLast = "";
    function netWatch(now){
        if(now - netWatchAt < 300) return;
        netWatchAt = now;
        var bodies = 0;
        Groups.unit.each(cons(u => { if(u != null && u.type == driverType) bodies++; }));
        var ready = 0, undrawn = 0;
        Object.keys(netMachines).forEach(k => {
            var nm = netMachines[k];
            if(nm.init) ready++;
            if(nm.init && (nm.drawn === undefined || now - nm.drawn > 120)) undrawn++;
        });
        var txt = "";
        if(bodies > ready) txt = "mb: " + bodies + " machine bodies seen, pictures with a position: " + ready + " (structure packets: " + netDbg.struct + ", poses: " + netDbg.pose + ")";
        else if(undrawn > 0 || netDbg.lastDrawErr) txt = "mb: drawing problem" + (netDbg.lastDrawErr ? ": " + netDbg.lastDrawErr : " (" + undrawn + " machine(s) not drawn)");
        if(txt != "" && txt != netWatchLast){
            netWatchLast = txt;
            try{ Vars.ui.showInfoToast(txt, 6); }catch(e){ /* no toast */ }
            netDbg.lastDrawErr = null;                        // reported: if it still happens it comes back
        }else if(txt == ""){
            netWatchLast = "";
        }
    }
    function netDebugText(){
        var keys = Object.keys(netMachines);
        var first = keys.length > 0 ? netMachines[keys[0]] : null;
        return "mb net  machines: " + keys.length +
            (first == null ? "" : "  (parts " + first.parts.length + ", " + (first.init ? "pose ok" : "no pose") + ")") +
            "\nstruct " + netDbg.struct + " (" + netAgo(netDbg.lastStruct) + ")" +
            "\npose " + netDbg.pose + " (" + netAgo(netDbg.lastPose) + ")" +
            "\ntiles " + netDbg.tiles + " (" + netAgo(netDbg.lastTiles) + ")  gone " + netDbg.gone + "  fx " + netDbg.fx +
            "\nbuild mode " + (buildMode ? "on" : "off") +
            (netDbg.lastDrawErr ? "\ndraw error: " + netDbg.lastDrawErr : "");
    }

    function netOnStruct(str){
        netDbg.struct++; netDbg.lastStruct = Time.globalTime;
        var seg = String(str).split("|");
        if(seg.length < 4) return;
        var id = Number(seg[0]);
        var Turret = Packages.mindustry.world.blocks.defense.turrets.Turret;
        var FP = Packages.mindustry.world.blocks.defense.ForceProjector;
        var parts = [];
        seg[3].split(";").forEach(e => {
            if(e.length == 0) return;
            var f = e.split(",");
            var blk = Vars.content.getByName(ContentType.block, f[0]);
            if(blk == null){ parts.push(null); return; }     // a block this client does not have: its place is kept
            var region = blk.fullIcon;
            if(region == null || !region.found()) region = blk.region;
            var p = {blk: blk, region: region, lx: Number(f[1]), ly: Number(f[2]), rot: Number(f[3]), turret: false, fp: false};
            try{
                if(blk instanceof Turret){
                    p.turret = true;
                    p.base = blk.baseRegion;
                    p.head = blk.region;
                    p.heatRegion = Core.atlas.has(blk.name + "-heat") ? Core.atlas.find(blk.name + "-heat") : null;
                    p.trot = 0; p.rot2 = 0; p.heat = 0; p.aimed = false;
                    if(p.base == null || !p.base.found() || p.head == null || !p.head.found()) p.turret = false;
                }else if(blk instanceof FP){
                    p.fp = true;
                    p.shield = 0;
                }
            }catch(e2){ p.turret = false; }
            parts.push(p);
        });
        var nm = netMachines[id];
        if(nm == null){
            nm = netMachines[id] = {id: id, x: 0, y: 0, ang: 0, tx: 0, ty: 0, tang: 0, init: false, seen: 0, parts: [], sig: ""};
        }
        if(parts.length == 0){
            delete netMachines[id];
            return;
        }
        nm.parts = parts;
        nm.sig = seg[2];
        try{ nm.team = Team.get(Number(seg[1])); }catch(eT){ nm.team = Team.derelict; }
        nm.seen = Time.globalTime;
        // the first pose comes with the structure: the machine is drawn at once, also if the poses (unreliable) are lost for a while
        if(!nm.init && seg.length > 4){
            var ip = seg[4].split(",");
            nm.x = nm.tx = Number(ip[0]); nm.y = nm.ty = Number(ip[1]); nm.ang = nm.tang = Number(ip[2]);
            nm.vx = 0; nm.vy = 0; nm.fh = 1;
            nm.poseT = Time.globalTime;
            nm.init = true;
        }
    }

    function netOnState(str){
        var seg = String(str).split("|");
        if(seg.length < 3) return;
        var nm = netMachines[Number(seg[0])];
        if(nm == null || nm.sig !== seg[1]) return;      // the picture of the machine has changed: wait for the new one
        seg[2].split(";").forEach(e => {
            if(e.length == 0) return;
            var f = e.substring(1).split(":");
            var p = nm.parts[Number(f[0])];
            if(p == null) return;
            if(e.charAt(0) == "T" && p.turret){
                p.trot = Number(f[1]);
                p.heat = Number(f[2]) / 100;
                if(!p.aimed){ p.rot2 = p.trot; p.aimed = true; }
            }else if(e.charAt(0) == "F" && p.fp){
                p.shield = Number(f[1]);
            }else if(e.charAt(0) == "H"){
                p.hot = Number(f[1]) / 100;
            }
        });
    }

    function netOnPose(str){
        netDbg.pose++; netDbg.lastPose = Time.globalTime;
        String(str).split(";").forEach(e => {
            var f = e.split(",");
            var nm = netMachines[Number(f[0])];
            if(nm == null){ netRequestStruct(Number(f[0])); return; }      // its picture has not come yet: ask for it
            var stamp = f.length > 7 ? Number(f[7]) : -1;
            if(stamp >= 0){
                if(nm.poseStamp !== undefined && stamp < nm.poseStamp) return;            // an older pose (the reliable copy came late)
                nm.poseStamp = stamp;
            }
            nm.tx = Number(f[1]); nm.ty = Number(f[2]); nm.tang = Number(f[3]);
            nm.vx = f.length > 5 ? Number(f[4]) : 0; nm.vy = f.length > 5 ? Number(f[5]) : 0;
            nm.fh = f.length > 6 ? Number(f[6]) : 1;
            nm.poseT = Time.globalTime;
            if(!nm.init){ nm.x = nm.tx; nm.y = nm.ty; nm.ang = nm.tang; nm.init = true; }
            nm.seen = Time.globalTime;
        });
    }

    /** the host changed real tiles on its own (a machine took off or landed, moved, lost blocks): do the same here */
    function netOnTiles(text){
        if(!Vars.net.client()) return;
        netDbg.tiles++; netDbg.lastTiles = Time.globalTime;
        String(text).split(";").forEach(item => {
            var f = item.split(",");
            if(f.length < 5) return;
            var t = Vars.world.tile(Number(f[0]), Number(f[1]));
            if(t == null) return;
            var id = Number(f[2]);
            if(id < 0){
                if(t.block() != Blocks.air) t.setBlock(Blocks.air);
                return;
            }
            var blk = Vars.content.block(id);
            if(blk == null) return;
            var team = Team.get(Number(f[3]));
            var rot = Number(f[4]);
            var code = f.length > 5 ? f[5] : "";
            if(t.block() === blk && t.build != null && t.team() === team && t.build.tile === t){     // already so
                netApplyCfg(t.build, code);
                return;
            }
            t.setBlock(blk, team, rot);
            netApplyCfg(t.build, code);
        });
    }

    /** the setting that the host sent with a tile: the item of a source / sorter, a liquid, a number, the links */
    function netApplyCfg(b, code){
        if(b == null || !code) return;
        try{
            var q = String(code).split("~");
            var c = null;
            if(q[0] == "i") c = {kind: 4, item: q[1]};
            else if(q[0] == "l") c = {kind: 5, liquid: q[1]};
            else if(q[0] == "b") c = {kind: 6, val: q[1] == "1"};
            else if(q[0] == "n") c = {kind: 6, val: Number(q[1])};
            else if(q[0] == "p1" || q[0] == "p2") c = {kind: Number(q[0].charAt(1)), abs: q[1].split("^").map(Number)};
            if(c != null) applyConfigAbs(b, c, a => a);
        }catch(e){ logErr("net config", e); }
    }

    var netCliDone = false, netCliRef = null;
    function netInstallHandlers(){
        if(Vars.netClient == null) return;
        // reinstall if NetClient instance was recreated (join via Claj / reconnect)
        if(netCliDone && netCliRef === Vars.netClient) return;
        netCliDone = false;
        try{
            Vars.netClient.addPacketHandler("mb-fx", cons(s => { try{ netOnFx(s); }catch(e){ logErr("net fx", e); } }));
            Vars.netClient.addPacketHandler("mb-tiles", cons(s => { try{ netOnTiles(s); }catch(e){ logErr("net tiles", e); } }));
            Vars.netClient.addPacketHandler("mb-struct", cons(s => { try{ netOnStruct(s); }catch(e){ logErr("net struct", e); } }));
            Vars.netClient.addPacketHandler("mb-state", cons(s => { try{ netOnState(s); }catch(e){ logErr("net state", e); } }));
            Vars.netClient.addPacketHandler("mb-pose", cons(s => { try{ netOnPose(s); }catch(e){ logErr("net pose", e); } }));
            Vars.netClient.addPacketHandler("mb-msg", cons(s => {
                try{
                    var f = String(s).split("~");
                    say(f[0], f[1] === "" ? undefined : f[1], f[2] === "" ? undefined : f[2], f[3] === "" ? undefined : f[3]);
                }catch(e){ logErr("net msg", e); }
            }));
            Vars.netClient.addPacketHandler("mb-bm", cons(s => { buildMode = String(s) == "1"; }));
            Vars.netClient.addPacketHandler("mb-gone", cons(s => {
                try{ netDbg.gone++; delete netMachines[Number(s)]; }catch(e){ logErr("mb-gone", e); }
            }));
            Vars.netClient.addPacketHandler("mb-me", cons(s => {
                try{
                    var f = String(s).split(",");
                    var first = netMe == null;
                    netMe = [Number(f[0]), Number(f[1])];
                    var u = Vars.player == null ? null : Vars.player.unit();
                    if(first && u != null && u.type == driverType) u.set(netMe[0], netMe[1]);
                }catch(e){ logErr("net me", e); }
            }));
            netCliDone = true;
            netCliRef = Vars.netClient;
            Log.info("[mb] client packet handlers installed");
        }catch(e){
            logErr("net handlers", e);
        }
    }

    /** the overheat of a reactor booster as the client sees it: the glow and the smoke (the host sends the heat in percent) */
    function netHeatGlow(nm, p, w){
        var heat = Mathf.clamp(p.hot, 0, 1), sz = p.blk.size * TS;
        var wave = 0.5 + 0.5 * Math.sin(Time.time * (0.16 + heat * 0.42) + nm.id);
        try{
            Draw.blend(Packages.arc.graphics.Blending.additive);
            Draw.color(heatTint(heat));
            Draw.alpha(heat * (0.30 + 0.30 * wave));
            Draw.rect(p.region, w[0], w[1], sz, sz, nm.ang);
            if(pulseBig == null) pulseBig = Core.atlas.find(MOD + "-pulse-big");
            var k = (0.55 + 0.55 * heat) * (0.92 + 0.08 * wave);
            Draw.color(heatTint(Math.min(1, heat + 0.2)));
            Draw.alpha(Math.min(1, heat * 1.2) * (0.55 + 0.45 * wave));
            Draw.rect(pulseBig, w[0], w[1], pulseBig.width * TS / 32 * k, pulseBig.height * TS / 32 * k);
        }finally{
            Draw.blend();
            Draw.color();
        }
        p.fxAcc = (p.fxAcc || 0) + Time.delta * (2 + 12 * heat) / 60;
        while(p.fxAcc >= 1){
            p.fxAcc -= 1;
            try{ Fx.reactorsmoke.at(w[0] + randRange(sz * 0.38), w[1] + randRange(sz * 0.38)); }catch(e){ /* no smoke */ }
        }
    }

    /** an effect that the host made (a reactor blowing up, a machine hitting the ground) */
    function netOnFx(text){
        netDbg.fx++;
        var f = String(text).split(",");
        var kind = f[0], x = Number(f[1]), y = Number(f[2]), a = Number(f[3]);
        if(kind == "boom"){
            try{ Fx.reactorExplosion.at(x, y); }catch(e1){ /* no picture */ }
            try{ Fx.massiveExplosion.at(x, y); }catch(e2){ /* no picture */ }
            try{ Sounds.explosionbig.at(x, y); }catch(e3){ /* no sound */ }
            try{ Effect.shake(6, 16, x, y); }catch(e4){ /* no shake */ }
        }else if(kind == "crash"){
            try{ Effect.shake(Math.min(18, 5 + a * 0.12), 30, x, y); }catch(e5){ /* no shake */ }
            try{ Sounds.explosionbig.at(x, y); }catch(e6){ /* no sound */ }
            var rr = Math.min(80, 8 + a * 0.5);
            for(var i = 0; i < Math.min(14, 4 + Math.floor(a / 8)); i++){
                try{
                    var fx = i % 3 == 0 ? Fx.massiveExplosion : Fx.explosion;
                    fx.at(x + randRange(rr), y + randRange(rr));
                }catch(e7){ /* no picture */ }
            }
        }
    }

    /** the machine of the host as the client sees it: blocks and shadows, the turrets aimed and glowing, the shields */
    function netDrawMachines(){
        if(!Vars.net.client()) return;
        try{ netInstallHandlers(); }catch(eI){}
        var now = Time.globalTime;
        // ask host for any flying body we see but have no picture of (Claj may drop the first struct)
        try{
            Groups.unit.each(cons(u => {
                if(u == null || u.type != driverType) return;
                var id = 0;
                try{ id = u.flag | 0; }catch(e){ id = 0; }
                if(id > 0 && (netMachines[id] == null || netMachines[id].parts == null || netMachines[id].parts.length == 0))
                    netRequestStruct(id);
            }));
        }catch(eU){}
        try{ netWatch(now); }catch(eW){ /* only a hint */ }
        var f = 1 - Math.exp(-Time.delta * 0.55);       // snappier follow of host pose (less teleport)
        var cam = Core.camera;
        Object.keys(netMachines).forEach(k => {
            var nm = netMachines[k];
            if(now - nm.seen > 240){ delete netMachines[k]; return; }     // no news for 4 s: landed or destroyed
            if(!nm.init) return;
            // soft follow host pose; little prediction (big prediction = teleport when ping spikes)
            var dtp = Math.min(6, Math.max(0, now - (nm.poseT || now)));
            var tx = nm.tx + (nm.vx || 0) * dtp * 0.35;
            var ty = nm.ty + (nm.vy || 0) * dtp * 0.35;
            var err = Mathf.dst(nm.x, nm.y, nm.tx, nm.ty);
            if(err > 96){ nm.x = nm.tx; nm.y = nm.ty; nm.ang = nm.tang; }
            else{
                nm.x += (tx - nm.x) * f;
                nm.y += (ty - nm.y) * f;
                nm.ang += (((nm.tang - nm.ang + 540) % 360 + 360) % 360 - 180) * f;
            }
            nm.parts.forEach(p => {
                if(p != null && p.turret) p.rot2 += (((p.trot - p.rot2 + 540) % 360 + 360) % 360 - 180) * Math.min(1, f * 1.6);
            });
            if(Math.abs(nm.x - cam.position.x) > cam.width / 2 + 400 || Math.abs(nm.y - cam.position.y) > cam.height / 2 + 400){
                nm.drawn = now;                               // off the screen: nothing to draw, and nothing is wrong
                return;
            }
            var c = Mathf.cosDeg(nm.ang), s = Mathf.sinDeg(nm.ang);
            var at = p => [nm.x + p.lx * c - p.ly * s, nm.y + p.lx * s + p.ly * c];
            var hk = nm.fh === undefined || isNaN(nm.fh) ? 1 : Math.max(0, nm.fh);        // a falling machine is low: the shadow is close
            if(hk < 0.995 && nm.parts.length > 0){                                          // ... and it burns and smokes
                nm.fxAcc = (nm.fxAcc || 0) + Time.delta * (0.08 + 0.5 * (1 - hk));
                while(nm.fxAcc >= 1){
                    nm.fxAcc -= 1;
                    var fp0 = nm.parts[Math.floor(Math.random() * nm.parts.length)];
                    if(fp0 == null) continue;
                    var fw = at(fp0);
                    try{ if(Math.random() < 0.55) Fx.fuelburn.at(fw[0], fw[1]); else Fx.smoke.at(fw[0], fw[1]); }catch(eF){ /* no picture */ }
                }
            }
            nm.drawn = now;                                   // (the cull above also counts: nothing to draw out of the screen)
            Draw.draw(BODY_Z, () => {
                try{
                    var white = Core.atlas.white();
                    Draw.color(Pal.shadow);
                    nm.parts.forEach(p => {
                        if(p == null) return;
                        try{
                            var w = at(p), sz = p.blk.size * TS;
                            Draw.rect(white, w[0] + SHADOW_X * hk, w[1] + SHADOW_Y * hk, sz, sz, nm.ang);
                        }catch(eS){ netDbg.lastDrawErr = String(eS); }
                    });
                    Draw.color();
                    // blocks, then the heads of the turrets over them
                    // turret BASE follows the hull only (nm.ang), never the aim angle
                    nm.parts.forEach(p => {
                        if(p == null) return;
                        try{
                            var w = at(p), sz = p.blk.size * TS;
                            if(p.turret){
                                if(p.base != null && p.base.found()) Draw.rect(p.base, w[0], w[1], sz, sz, nm.ang);
                            }else if(p.region != null){
                                Draw.rect(p.region, w[0], w[1], sz, sz, nm.ang + (p.blk.rotate ? p.rot * 90 : 0));
                            }else{
                                Draw.color(Color.gray);                       // a block without a picture: a grey square, so the machine is still seen
                                Draw.rect(white, w[0], w[1], sz, sz, nm.ang);
                                Draw.color();
                            }
                        }catch(eB){ netDbg.lastDrawErr = String(eB); }
                    });
                    // turret HEAD: aim in world space (hull ang + relative aim)
                    nm.parts.forEach(p => {
                        if(p == null || !p.turret || p.head == null) return;
                        var w = at(p);
                        var aim = nm.ang + p.rot2;
                        Draw.rect(p.head, w[0], w[1], aim - 90);
                    });
                    // a reactor booster that overheats: the glow, as on the host
                    nm.parts.forEach(p => {
                        if(p == null || !(p.hot > 0.02)) return;
                        try{ netHeatGlow(nm, p, at(p)); }catch(eHG){ try{ Draw.blend(); Draw.color(); }catch(e0){ /* nothing */ } }
                    });
                    // the glow of the hot guns: additive, with the blending forced
                    var hot = nm.parts.filter(p => p != null && p.turret && p.heat > 0.01 && p.heatRegion != null);
                    if(hot.length > 0){
                        try{
                            Draw.flush();
                            Draw.blend(Packages.arc.graphics.Blending.additive);
                            hot.forEach(p => {
                                var w = at(p);
                                Draw.color(p.blk.heatColor, p.heat);
                                Draw.rect(p.heatRegion, w[0], w[1], nm.ang + p.rot2 - 90);
                            });
                            Draw.flush();
                        }finally{
                            Draw.blend();
                            Draw.color();
                        }
                    }
                }catch(e){
                    logErr("net draw", e);
                }finally{
                    Draw.reset();
                }
            });
            // the shields go on the shield layer, where the game turns them into the animated picture
            var shields = nm.parts.filter(p => p != null && p.fp && p.shield > 0);
            if(shields.length > 0){
                Draw.draw(Layer.shields + 0.5, () => {
                    try{
                        var animated = flyAnimShields();
                        shields.forEach(p => {
                            var w = at(p);
                            var sides = 6, rotation = 0;
                            try{ sides = p.blk.sides; rotation = p.blk.shieldRotation; }catch(e1){ /* the usual hexagon */ }
                            Draw.color(nm.team == null ? Color.white : nm.team.color);
                            if(animated){
                                Fill.poly(w[0], w[1], sides, p.shield, rotation);
                            }else{
                                Lines.stroke(1.5);
                                Draw.alpha(0.09);
                                Fill.poly(w[0], w[1], sides, p.shield, rotation);
                                Draw.alpha(1);
                                Lines.poly(w[0], w[1], sides, p.shield, rotation);
                            }
                        });
                    }catch(e){
                        logErr("net shields", e);
                    }finally{
                        Draw.reset();
                    }
                });
            }
        });
    }

    function drawFlying(m){
        var cam = Core.camera;
        var reach = m.radius + 30;
        if(Math.abs(m.x - cam.position.x) > cam.width / 2 + reach || Math.abs(m.y - cam.position.y) > cam.height / 2 + reach) return;
        // Light: the game asks every building of the real world for its light; the blocks of a flying machine are not in it, so
        // illuminators gave no light in flight. Their parts hold real coordinates at this point of the frame.
        if(Vars.state.rules.lighting){
            for(var li = 0; li < m.parts.length; li++){
                var lb = m.parts[li];
                if(lb.dead || !lb.block.emitLight) continue;
                try{ lb.drawLight(); }catch(eL){ logErr("drawLight", eL); }
            }
        }
        // shadows go under the machine, over the ground, buildings and ground units (and under the darkness of the map,
        // like the shadow of any flying unit)
        Draw.draw(Layer.groundUnit + 0.5, () => {
            try{
                drawShadows(m);
            }catch(e){
                logErr("drawShadows", e);
                Draw.color();
            }
        });
        // animated shields: the game draws every shield into a buffer that a shader turns into the animated picture, and only what
        // is drawn on the shield layer gets into that buffer. A shield drawn from inside the machine's own callback goes straight
        // to the screen as a solid fill. So the shields of a flying machine are drawn here, on the shield layer.
        if(flyAnimShields() && m.parts.some(b => !b.dead && isForceProjector(b))){
            Draw.draw(Layer.shields + 0.5, () => {
                if(m.mode != "fly" || machines.indexOf(m) < 0) return;
                var prevT = new Mat().set(Draw.trans());
                try{
                    withPocket(m, () => {
                        setPartsPocket(m);
                        Draw.flush();
                        var mat = new Mat();
                        mat.setToTranslation(m.x, m.y);
                        mat.rotate(m.ang);
                        mat.translate(-m.ref[0] * TS, -m.ref[1] * TS);
                        Draw.trans(mat);
                        m.parts.forEach(b => {
                            if(b.dead || !isForceProjector(b) || typeof b.drawShield !== "function") return;
                            try{ b.drawShield(); }catch(e1){ logErr("drawShield", e1); }
                        });
                        Draw.flush();
                        setPartsReal(m);
                    }, false);
                }catch(e){
                    logErr("flying shields", e);
                }finally{
                    Draw.flush();
                    Draw.trans(prevT);
                    Draw.reset();
                }
            });
        }
        // the machine itself goes over the darkness of the map (BODY_Z, see above), but still under bullets, effects and flying units
        Draw.draw(BODY_Z, () => {
            if(m.mode != "fly" || machines.indexOf(m) < 0) return;
            var prev = new Mat().set(Draw.trans());
            try{
                withPocket(m, () => {
                    setPartsPocket(m);
                    Draw.flush();
                    var mat = new Mat();
                    mat.setToTranslation(m.x, m.y);
                    mat.rotate(m.ang);
                    mat.translate(-m.ref[0] * TS, -m.ref[1] * TS);
                    Draw.trans(mat);
                    var heads = [];
                    var animShields = flyAnimShields();
                    withBlendFlush(() => {
                        m.parts.forEach(b => {
                            if(isTurret(b)){ heads.push(b); return; }
                            if(isTractor(b) || b.block instanceof MassDriverClass){ drawTractorPart(m, b); return; }
                            if(animShields && isForceProjector(b) && typeof b.drawShield === "function"){
                                // the shield of this block is drawn separately, on the shield layer (see below): here the block is
                                // drawn as if its shield were down
                                var wasBroken = b.broken;
                                b.broken = true;
                                try{ drawPartSafe(b); }finally{ b.broken = wasBroken; }
                            }else{
                                drawPartSafe(b);
                            }
                        });
                    });
                    var heatK = flyHeatScale();
                    var heatDraws = [];
                    drawTurretsSorted(heads, t => {
                        var r = t.rotation;
                        var hot = t.heat;
                        var hr = null;
                        if(typeof hot === "number" && hot > 0.0001) hr = heatRegionOf(t.block);
                        t.rotation = r - m.ang;
                        if(t.recoilOffset) t.recoilOffset.rotate(-m.ang);
                        var ox = t.recoilOffset ? t.recoilOffset.x : 0, oy = t.recoilOffset ? t.recoilOffset.y : 0;
                        if(hr != null) t.heat = 0;
                        try{
                            drawPartSafe(t);
                        }finally{
                            if(t.recoilOffset) t.recoilOffset.rotate(m.ang);
                            t.rotation = r;
                            if(typeof hot === "number") t.heat = hot;
                        }
                        if(hr != null) heatDraws.push({t: t, hr: hr, hot: hot, rot: r - m.ang - 90, ox: ox, oy: oy});
                    });
                    if(heatDraws.length > 0){
                        try{
                            var ADD = Packages.arc.graphics.Blending.additive;
                            Draw.flush();
                            Draw.blend(ADD);
                            for(var hi = 0; hi < heatDraws.length; hi++){
                                var hd = heatDraws[hi];
                                Draw.color(hd.t.block.heatColor, Math.min(1, hd.hot * heatK));
                                Draw.rect(hd.hr, hd.t.x + hd.ox, hd.t.y + hd.oy, hd.rot);
                            }
                            Draw.flush();
                        }finally{
                            Draw.blend();
                            Draw.color();
                        }
                    }
                    Draw.flush();
                    setPartsReal(m);
                }, false);
            }catch(e){
                logErr("drawFlying", e);
            }finally{
                Draw.flush();
                Draw.trans(prev);
                Draw.reset();
            }
        });
    }

    /** the game paints the ghost of a ground-bound block red where the ground does not fit; where the mod places it anyway
     *  (see freePlaceOk) the ghost is drawn over it again, plain, with an outline */
    function drawFreeGhost(){
        var input = Vars.control.input;
        // ground-bound blocks of a schematic that hangs on the cursor (they are placed when it is placed)
        var plans = input.selectPlans;
        for(var i = 0; i < plans.size; i++){
            var pl = plans.get(i);
            if(pl.breaking || pl.block == null || !isTerrainBlock(pl.block)) continue;
            if(freePlaceOk(pl.block, pl.x, pl.y, pl.rotation)) drawFreeGhostAt(pl.block, pl.x, pl.y);
        }
        if(Vars.mobile) return;
        var block = input.block;
        if(block == null || input.commandMode || !isTerrainBlock(block) || Core.scene.hasMouse()) return;
        var o = placeOrigin(block);
        if(!freePlaceOk(block, o[0], o[1], input.rotation)) return;
        drawFreeGhostAt(block, o[0], o[1]);
    }

    function drawFreeGhostAt(block, x, y){
        var size = block.size * TS;
        var cx = x * TS + block.offset, cy = y * TS + block.offset;
        Draw.z(Layer.overlayUI);
        Draw.color(Color.white, 0.9);
        Draw.rect(block.uiIcon, cx, cy, size, size);
        Lines.stroke(1.5);
        Draw.color(Pal.accent);
        Lines.rect(cx - size / 2, cy - size / 2, size, size);
        Draw.reset();
    }

    function drawBuildOverlay(){
        var landed = landedMachines();
        var cam = Core.camera;
        var w = cam.width, h = cam.height;
        var x0 = Math.max(0, Math.floor((cam.position.x - w / 2) / TS)), x1 = Math.min(Vars.world.width() - 1, Math.ceil((cam.position.x + w / 2) / TS));
        var y0 = Math.max(0, Math.floor((cam.position.y - h / 2) / TS)), y1 = Math.min(Vars.world.height() - 1, Math.ceil((cam.position.y + h / 2) / TS));

        // blue filter over everything that is not part of a machine (the world layer)
        var radius = Math.sqrt(w * w + h * h) / 2 + 24;
        Draw.z(Layer.blockOver);
        Vars.indexer.eachBlock(null, cam.position.x, cam.position.y, radius, boolf(b => true), cons(b => {
            var pos = b.tile.pos();
            for(var i = 0; i < landed.length; i++){
                if(landed[i].cells[pos] || landed[i].pending[pos]) return;
            }
            if(loose[pos]) return;          // fresh and unattached: shown red below, not as a world block
            if(isConstructing(b)) return;
            Draw.color(BLUE, 0.38);
            Fill.rect(b.x, b.y, b.block.size * TS, b.block.size * TS);
        }));

        // unattached blocks look like blocks about to be deconstructed
        landed.forEach(m => {
            // a machine that is drawn over the darkness (see landedLift) gets its marks over it too
            Draw.z(landedLift(m) ? BODY_Z + 0.1 : Layer.blockOver + 1);
            for(var k in m.pending){
                var x = Point2.x(+k), y = Point2.y(+k);
                Draw.color(Pal.remove, 0.45 + Mathf.absin(Time.time, 6, 0.2));
                Fill.rect(x * TS, y * TS, TS, TS);
            }
            // the machine layer gets a soft outline
            for(var k2 in m.cells){
                var x2 = Point2.x(+k2), y2 = Point2.y(+k2);
                Draw.color(Pal.accent, 0.12);
                Fill.rect(x2 * TS, y2 * TS, TS, TS);
            }
        });

        // fresh blocks that belong to no machine yet look the same: they are removed when the mode ends
        // unless a chain of blocks reaches a core / storage first
        Draw.z(Layer.blockOver + 1);
        for(var kl in loose){
            var lx = Point2.x(+kl), ly = Point2.y(+kl);
            Draw.color(Pal.remove, 0.45 + Mathf.absin(Time.time, 6, 0.2));
            Fill.rect(lx * TS, ly * TS, TS, TS);
        }

        // grid, one line per tile
        Draw.z(Layer.blockOver + 2);
        Lines.stroke(1);
        Draw.color(GRID, 0.28);
        for(var gx = x0; gx <= x1 + 1; gx++){
            Lines.line(gx * TS - TS / 2, y0 * TS - TS / 2, gx * TS - TS / 2, (y1 + 1) * TS - TS / 2);
        }
        for(var gy = y0; gy <= y1 + 1; gy++){
            Lines.line(x0 * TS - TS / 2, gy * TS - TS / 2, (x1 + 1) * TS - TS / 2, gy * TS - TS / 2);
        }
        // ... and once more over the machines that are drawn over the darkness
        landed.forEach(m => { if(landedLift(m)) drawLiftedGrid(m, x0, y0, x1, y1); });
        Draw.reset();

        // the front of every machine and the square of Y: a failure here must not take the rest of the overlay down
        try{
            landed.forEach(m => {
                Draw.z(landedLift(m) ? BODY_Z + 0.3 : Layer.blockOver + 3);
                drawFrontArrows(m);
            });
            Draw.z(SEL_Z);
            drawLayerSelection();
        }catch(e){
            logErr("build overlay extras", e);
        }
        Draw.reset();
    }

    // ---- the front of a machine: a green arrow on each of its cores / storages (R turns it) ----
    var ARROW_GREEN = Color.valueOf("3df25a");
    var ARROW_DARK = Color.valueOf("0b3d17");


    function fillArrow(cx, cy, deg, len, grow){
        var c = Mathf.cosDeg(deg), s = Mathf.sinDeg(deg);
        var half = len / 2 + grow;
        var head = len * 0.46 + grow;                     // length of the triangular head
        var headW = len * 0.30 + grow;                    // half of its width
        var shaftW = len * 0.09 + grow;                   // half of the width of the shaft
        var base = half - head;                           // where the head starts, along the arrow
        var px = (u, v) => cx + u * c - v * s;            // (along the arrow, across it) -> world x
        var py = (u, v) => cy + u * s + v * c;            // ... -> world y
        Fill.tri(px(half, 0), py(half, 0), px(base, headW), py(base, headW), px(base, -headW), py(base, -headW));
        Fill.quad(px(-half, shaftW), py(-half, shaftW), px(-half, -shaftW), py(-half, -shaftW),
            px(base, -shaftW), py(base, -shaftW), px(base, shaftW), py(base, shaftW));
    }

    /** the cores / storages of a landed machine: looked up again when the machines changed (and now and then, to be safe),
     *  not every frame */
    function machineHulls(m){
        var now = Time.globalTime;
        if(m.hullList === undefined || m.hullVer !== layoutVersion || now < m.hullStamp || now - m.hullStamp > 30){
            m.hullStamp = now;
            m.hullVer = layoutVersion;
            m.hullList = membersOf(m.cells, m.team).filter(isHull);
        }
        return m.hullList;
    }

    // The arrow itself is a picture (sprites/front-arrow.png, 64x64, points UP). If the atlas does not have it, the old
    // green polygon (fillArrow) is drawn instead.
    var frontArrowRegion = null;          // null = not looked up yet, false = not in the atlas
    function frontArrowPicture(){
        if(frontArrowRegion === null){
            try{
                frontArrowRegion = Core.atlas.has(MOD + "-front-arrow") ? Core.atlas.find(MOD + "-front-arrow") : false;
            }catch(e){
                logErr("front arrow sprite", e);
                frontArrowRegion = false;
            }
        }
        return frontArrowRegion;
    }

    function drawFrontArrows(m){
        var deg = frontDeg(m);                 // 90 = the front looks up, like the picture
        var hulls = machineHulls(m);
        var pic = frontArrowPicture();
        for(var i = 0; i < hulls.length; i++){
            var h = hulls[i];
            if(h.tile == null || h.tile.build !== h) continue;       // removed since the list was made
            if(pic){
                // the picture is a square the size of the block; the arrow inside it fills about 80% of it
                var side = Math.max(12, h.block.size * TS);
                Draw.color();
                Draw.rect(pic, h.x, h.y, side, side, deg - 90);
            }else{
                var len = Math.max(12, h.block.size * TS * 0.85);
                Draw.color(ARROW_DARK, 0.9);
                fillArrow(h.x, h.y, deg, len, 1.2);
                Draw.color(ARROW_GREEN);
                fillArrow(h.x, h.y, deg, len, 0);
            }
        }
    }

    /** the square that follows the cursor while Y is held: the blocks in it are tinted by the layer they will go to */
    function drawLayerSelection(){
        var d = layerDrag;
        if(d == null) return;
        var minX = Math.min(d.sx, d.cx), maxX = Math.max(d.sx, d.cx), minY = Math.min(d.sy, d.cy), maxY = Math.max(d.sy, d.cy);
        var single = minX == maxX && minY == maxY;
        var key = minX + "," + minY + "," + maxX + "," + maxY;
        if(d.list == null || d.key != key || Time.globalTime < d.stamp || Time.globalTime - d.stamp > 15){
            d.list = buildingsInRect(minX, minY, maxX, maxY, single ? null : Vars.player.team());
            d.key = key;
            d.stamp = Time.globalTime;
        }
        // only the blocks that will change their layer are tinted: blue = go to the world, machine colour = join the machine
        var list = d.list;
        var dir = single ? null : layerDirection(list, d.start);
        for(var i = 0; i < list.length; i++){
            var b = list[i];
            if(b.tile == null || isConstructing(b)) continue;
            var inMachine = machineOfBuild(b) != null;
            if(dir != null && inMachine != (dir == "leave")) continue;
            Draw.color(inMachine ? GRID : Pal.accent, 0.5);
            Fill.rect(b.x, b.y, b.block.size * TS, b.block.size * TS);
        }
        var rx = (minX - 0.5) * TS, ry = (minY - 0.5) * TS, rw = (maxX - minX + 1) * TS, rh = (maxY - minY + 1) * TS;
        Draw.z(SEL_Z + 1);
        Draw.color(Pal.accent, 0.1);
        Fill.rect(rx + rw / 2, ry + rh / 2, rw, rh);
        Lines.stroke(2);
        Draw.color(Pal.accentBack);
        Lines.rect(rx, ry - 1, rw, rh);
        Draw.color(Pal.accent);
        Lines.rect(rx, ry, rw, rh);
        Draw.reset();
    }

    // the bodies are smaller while a frame is drawn (see shrinkBodies); restored right after the frame
    runEvent(Trigger.preDraw, () => {
        restoreBodies();
        restoreBeamCuts();
        try{ applyBeamCuts(); }catch(e){ logErr("applyBeamCuts", e); }
    });
    runEvent(Trigger.postDraw, () => { restoreBodies(); restoreBeamCuts(); });

    runEvent(Trigger.draw, () => {
        shrinkBodies();
        if(!Vars.state.isGame()) return;
        refreshDarkness();
        flyingMachines().forEach(m => drawFlying(m));
        try{ netDrawMachines(); }catch(e){ logErr("netDrawMachines", e); }
        // landed machines: the game draws their blocks under the darkness, where it lies they are drawn once more over it
        landedMachines().forEach(m => { if(landedLift(m)) drawLanded(m); });
        if(buildMode){
            if(!Vars.net.client()) drawBuildOverlay();      // (a client does not know which blocks belong to a machine)
            try{ drawFreeGhost(); }catch(e){ logErr("free placement ghost", e); }
        }
    });

    onEvent(ClientLoadEvent, () => {
        netCliDone = false;
        netInstallHandlers();
        // settings
        Vars.ui.settings.addCategory("mb", cons(t => {
            t.sliderPref("mb-booster-power", BASE_BOOSTER_POWER, 1, 180, 1, i => "" + i);
            t.sliderPref("mb-hud-scale", 80, 40, 150, 5, i => i + "%");          // size of the build / drive panel
            t.sliderPref("mb-ship-ui-scale", 85, 40, 150, 5, i => i + "%");      // size of the window of a ship control block
            t.checkPref("mb-autoturn", true);
            t.checkPref("mb-sorted-turrets", true);
            t.checkPref("mb-ship-msgs", true);
            t.checkPref("mb-fall", true);
            t.checkPref("mb-netdebug", false);
            t.checkPref("mb-shipinfo", false);
        }));
        // the jobs of the ships on the screen: what each one does and why it waits (setting: ship status)
        Vars.ui.hudGroup.fill(cons(root => {
            root.name = "mb-ship-info";
            try{ root.touchable = Touchable.disabled; }catch(e){ /* only cosmetic */ }
            root.right();
            root.table(Styles.black6, cons(t => {
                t.margin(4);
                t.visible = false;
                t.update(run(() => { t.visible = !Vars.net.client() && Core.settings.getBool("mb-shipinfo", false); }));
                t.label(prov(() => shipInfoText())).left();
            }));
        }));
        // what the client has received from the host: for finding out why a machine is not seen (settings: network info)
        Vars.ui.hudGroup.fill(cons(root => {
            root.name = "mb-net-debug";
            try{ root.touchable = Touchable.disabled; }catch(e){ /* only cosmetic */ }
            root.left();
            root.table(Styles.black6, cons(t => {
                t.margin(4);
                t.visible = false;
                t.update(run(() => { t.visible = Vars.net.client() && Core.settings.getBool("mb-netdebug", false); }));
                t.label(prov(() => netDebugText())).left();
            }));
        }));

        // blinking hint, styled like the vanilla "your core is under attack" message
        Vars.ui.hudGroup.fill(cons(root => {
            root.name = "mb-booster-hint";
            try{ root.touchable = Touchable.disabled; }catch(e){ /* only cosmetic */ }
            root.top();
            root.table(Styles.black6, cons(t => {
                t.margin(4);
                t.label(prov(() => bundle("mb.hud.noboosters"))).pad(2).update(cons(l => {
                    l.color.set(Color.orange).lerp(Color.scarlet, Mathf.absin(Time.time, 2, 1));
                }));
            })).padTop(64).visible(boolp(() => needBoostersHint()));
        }));

        // HUD: a compact panel, rebuilt (not just hidden) when the state changes, so that it never keeps an empty dark
        // area where a hidden label or the touch pad used to be.
        var hudSig = "";
        var hudCollapsed = false;
        // size of the panel: a setting (percent, 40..150); every size and the letters follow it
var hudK = () => sizeSetting("mb-hud-scale", 80) / 100;
var BTN_W = 124, BTN_H = 34, PAD_BTN = 46, HK = 1;
var applySizes = () => { HK = hudK(); BTN_W = Math.round(124 * HK); BTN_H = Math.round(34 * HK); PAD_BTN = Math.round(46 * HK); };
applySizes();

        var hudButton = (t, getText, fn) => t.button("", Styles.defaultt, safe("hud button", fn)).update(b => {
            b.setText(getText());
            try{ var lb = b.getLabel(); lb.setFontScale(HK); lb.setWrap(false); }catch(e){ /* only the size of the text */ }
        }).height(BTN_H);

        var hudSignature = () => {
            return [buildMode, poss != null || netDriving, hudCollapsed, Vars.mobile, hudText() != "", hudK()].join("|");
        };

        // the panel can be moved up and down (not sideways): the step is kept in the settings. The panel sits in the middle
        // of the left edge, so moving it by d means d*2 of empty space on the opposite side of the cell.
        var hudRoot = null, hudCell = null;
        var hudOffY = Core.settings == null ? 0 : Core.settings.getInt("mb-hud-y", 0);
        var applyHudOffset = (byUser) => {
            if(hudCell == null || hudRoot == null) return;
            if(byUser){
                // (at start the size of the screen is not known yet, so the saved value is used as it is)
                var limit = Math.max(0, Vars.ui.hudGroup.getHeight() / 2 - 120);
                hudOffY = Mathf.clamp(hudOffY, -limit, limit);
                try{ Core.settings.put("mb-hud-y", Math.round(hudOffY)); }catch(e){ /* not saved */ }
            }
            hudCell.padTop(hudOffY < 0 ? -2 * hudOffY : 0).padBottom(hudOffY > 0 ? 2 * hudOffY : 0);
            hudRoot.invalidateHierarchy();
        };
        var moveButtons = (t, iconStyle) => {
            t.button(Icon.upOpen, iconStyle, () => { hudOffY += 40; applyHudOffset(true); }).size(BTN_H);
            t.button(Icon.downOpen, iconStyle, () => { hudOffY -= 40; applyHudOffset(true); }).size(BTN_H);
        };

        var buildHudContents = t => {
            applySizes();
            t.margin(Math.max(1, Math.round(4 * HK)));
            t.defaults().pad(Math.max(1, Math.round(2 * HK)));
            var iconStyle = Styles.defaulti || Styles.clearNonei;
            var driving = poss != null || netDriving;
            var cols = hudCollapsed ? 3 : 5;
            if(hudCollapsed){
                // only the way back, and the pad while a machine is driven
                t.button(Icon.rightOpen, iconStyle, () => { hudCollapsed = false; }).size(BTN_H);
                moveButtons(t, iconStyle);
            }else{
                // row 1: build mode, help, collapse
                hudButton(t, () => buildMode ? bundle("mb.btn.exitbuild") : bundle("mb.btn.build"), () => { toggleBuild(); }).width(BTN_W).growX();
                t.button("?", Styles.defaultt, safe("hud help", () => { Vars.ui.showInfo(bundle("mb.hud.build")); })).size(BTN_H);
                t.button(Icon.leftOpen, iconStyle, () => { hudCollapsed = true; }).size(BTN_H);
                moveButtons(t, iconStyle);
                t.row();
                // row 2: drive
                hudButton(t, () => (poss != null || netDriving) ? bundle("mb.btn.leave") : bundle("mb.btn.enter"), () => { togglePossess(); }).colspan(cols).growX();
                t.row();
                // row 3: park
                hudButton(t, () => {
                    var pm = parkTarget();
                    return pm != null && pm.mode == "land" && pm.parked ? bundle("mb.btn.unpark") : bundle("mb.btn.park");
                }, () => { togglePark(); }).colspan(cols).growX();
                t.row();
                // the front of the machine (R / Shift+R on a keyboard): two arrows for a touch screen
                if(buildMode){
                    t.table(cons(fr => {
                        fr.defaults().pad(1);
                        fr.label(prov(() => bundle("mb.hud.front"))).padRight(4).left().growX().get().setFontScale(HK);
                        fr.button(Icon.left, iconStyle, safe("turn front left", () => { turnFrontButton(1); })).size(BTN_H);
                        fr.button(Icon.right, iconStyle, safe("turn front right", () => { turnFrontButton(-1); })).size(BTN_H);
                    })).colspan(cols).growX();
                    t.row();
                }
                // size of this panel, right here (also a setting)
                t.table(cons(sz => {
                    sz.defaults().pad(1);
                    sz.label(prov(() => bundle("mb.hud.size"))).padRight(4).left().growX().get().setFontScale(0.8 * HK);
                    sz.button("-", Styles.defaultt, safe("hud smaller", () => { stepSizeSetting("mb-hud-scale", 80, -10); })).size(Math.round(BTN_H * 0.8));
                    sz.label(prov(() => Math.round(hudK() * 100) + "%")).width(Math.round(44 * HK)).center().get().setFontScale(0.8 * HK);
                    sz.button("+", Styles.defaultt, safe("hud bigger", () => { stepSizeSetting("mb-hud-scale", 80, 10); })).size(Math.round(BTN_H * 0.8));
                })).colspan(cols).growX();
                t.row();
                if(driving){
                    t.label(prov(() => hudText())).wrap().width(BTN_W + BTN_H * 2).left().get().setFontScale(0.8 * HK);
                    t.row();
                }
            }
            // touch stick: only while a machine is driven on a phone. Analog: the direction of the finger from the centre
            // is the direction of flight (any angle), the distance from the centre is the share of the top speed.
            if(driving && Vars.mobile){
                var JOY = Math.round(160 * HK);
                joyX = 0; joyY = 0; joyOn = false;
                var joy = null, knob = null;
                try{
                    // a round stick drawn by hand: a ring, a faint inner ring, four ticks and a knob that follows the finger
                    joy = extend(Packages.arc.scene.Element, {
                        draw(){
                            var L = Packages.arc.graphics.g2d.Lines;
                            var cx = this.x + this.width / 2, cy = this.y + this.height / 2;
                            var R = Math.min(this.width, this.height) / 2;
                            Draw.color(0, 0, 0, joyOn ? 0.5 : 0.36);
                            Fill.circle(cx, cy, R);
                            L.stroke(3);
                            Draw.color(Pal.accent, joyOn ? 0.95 : 0.6);
                            L.circle(cx, cy, R - 2);
                            L.stroke(2);
                            Draw.color(Pal.accent, 0.22);
                            L.circle(cx, cy, R * 0.5);
                            Draw.color(Pal.accent, 0.4);
                            for(var k = 0; k < 4; k++){
                                L.lineAngle(cx + Mathf.cosDeg(k * 90) * R * 0.7, cy + Mathf.sinDeg(k * 90) * R * 0.7, k * 90, R * 0.16);
                            }
                            var kx = cx + joyX * R * 0.62, ky = cy + joyY * R * 0.62;
                            Draw.color(0, 0, 0, 0.35);
                            Fill.circle(kx + 2, ky - 2, R * 0.3);
                            Draw.color(Pal.accent, joyOn ? 1 : 0.85);
                            Fill.circle(kx, ky, R * 0.3);
                            Draw.color(1, 1, 1, 0.35);
                            Fill.circle(kx - R * 0.07, ky + R * 0.07, R * 0.12);
                            Draw.reset();
                        }
                    });
                    joy.setSize(JOY, JOY);
                    joy.touchable = Touchable.enabled;
                }catch(eJ){
                    logErr("round stick", eJ);
                    joy = new Table();                                  // the old square one
                    joy.touchable = Touchable.enabled;
                    joy.background(Styles.black6);
                    knob = new Packages.arc.scene.ui.Image(Packages.mindustry.gen.Tex.whiteui);
                    knob.color.set(Pal.accent);
                    joy.add(knob).size(30);
                }
                var setJoy = (x, y) => {
                    var cx = joy.getWidth() / 2, cy = joy.getHeight() / 2, r = Math.max(1, Math.min(cx, cy));
                    var dx = (x - cx) / r, dy = (y - cy) / r;
                    var len = Math.sqrt(dx * dx + dy * dy);
                    if(len > 1){ dx /= len; dy /= len; len = 1; }
                    if(len < 0.12){ dx = 0; dy = 0; }       // dead zone in the middle
                    joyX = dx; joyY = dy;
                };
                joy.addListener(extend(Packages.arc.scene.event.InputListener, {
                    touchDown(event, x, y, pointer, button){ joyOn = true; setJoy(x, y); return true; },
                    touchDragged(event, x, y, pointer){ if(joyOn) setJoy(x, y); },
                    touchUp(event, x, y, pointer, button){ joyOn = false; joyX = 0; joyY = 0; }
                }));
                joy.update(run(() => {
                    // a lost "finger up" must never leave the machine flying on its own
                    if(joyOn && !Core.input.isTouched()){ joyOn = false; joyX = 0; joyY = 0; }
                    if(knob != null){
                        var r = Math.min(joy.getWidth(), joy.getHeight()) / 2;
                        knob.translation.set(joyX * r * 0.62, joyY * r * 0.62);
                    }
                }));
                t.add(joy).size(JOY).colspan(cols).center();
            }
        };

        Vars.ui.hudGroup.fill(cons(root => {
            root.name = "mb-hud";
            root.left();
            hudRoot = root;
            hudCell = root.table(Styles.black6, cons(t => {
                t.update(run(() => {
                    try{
                        var sig = hudSignature();
                        if(sig === hudSig) return;
                        hudSig = sig;
                        t.clearChildren();
                        buildHudContents(t);
                        t.pack();
                    }catch(e){ logErr("hud rebuild", e); }
                }));
            })).visible(boolp(() => Vars.state.isGame() && Vars.ui.hudfrag.shown));
            applyHudOffset();
        }));

        // Hover panel of a booster of a FLYING machine. The blocks of a landed machine are real blocks, the game shows their
        // panel itself (see Building.displayConsumption of the boosters); the blocks of a flying machine live in a private
        // tile array that the game's hover does not see, so the same panel is built here, next to the cursor.
        var hoverTable = new Table();
        hoverTable.name = "mb-hover";
        hoverTable.background(Styles.black6);
        hoverTable.margin(6);
        hoverTable.touchable = Touchable.disabled;
        hoverTable.visible = false;   // (Rhino sees Element.visible as the boolean field, so visible(Boolp) cannot be called)
        hoverTable.update(run(() => {
            try{ updateHover(hoverTable); }catch(e){ logErr("hover panel", e); }
            hoverTable.visible = hoverShown;
        }));
        Vars.ui.hudGroup.addChild(hoverTable);
    });

    var hoverShown = false, hoverBuild = null;

    /** the booster of a flying machine of the player's team under the cursor, or null */
    function hoveredFlyingBooster(){
        if(Vars.mobile || Vars.player == null || !Vars.state.isGame() || Core.scene.hasMouse() || Core.scene.hasDialog()) return null;
        var wx = Core.input.mouseWorldX(), wy = Core.input.mouseWorldY();
        var team = Vars.player.team();
        var fl = flyingMachines();
        for(var i = 0; i < fl.length; i++){
            var m = fl[i];
            if(m.team.id != team.id || m.pocket == null) continue;
            var reach = m.radius + 8;
            if(Mathf.dst2(wx, wy, m.x, m.y) > reach * reach) continue;
            var p = partAtWorld(m, wx, wy);
            if(p != null && !p.dead && isBooster(p)) return p;
        }
        return null;
    }

    function updateHover(table){
        var want = hoveredFlyingBooster();
        if(want == null){
            hoverShown = false;
            hoverBuild = null;
            return;
        }
        if(hoverBuild == null || hoverBuild.id != want.id){
            hoverBuild = want;
            table.clearChildren();
            want.display(table);
            table.pack();
        }
        hoverShown = true;
        var v = Core.scene.screenToStageCoordinates(Tmp.v1.set(Core.input.mouseX(), Core.input.mouseY()));
        var w = table.getWidth(), h = table.getHeight();
        var x = Math.max(4, Math.min(v.x + 20, Core.graphics.getWidth() - w - 4));
        var y = Math.max(h + 4, Math.min(v.y - 20, Core.graphics.getHeight() - 4));
        table.setPosition(x, y, Align.topLeft);
    }

    function hudText(){
        if(buildMode) return bundle("mb.hud.build");
        if(poss != null){
            var m = poss.m;
            var st = m.mode == "fly" && m.stats != null ? m.stats : machineStats(m);
            if(st.boosters == 0) return bundle("mb.hud.nowheels", st.cells);
            var spd = m.mode == "fly" ? flightSpeed(m) : st.speed;
            return bundle("mb.hud.drive", spd.toFixed(2), st.boosters, st.cells);
        }
        return "";
    }

    // "boosters are needed": the machine under construction has none (checked a few times a second)
    var hintValue = false, hintStamp = -1000;
    function needBoostersHint(){
        if(!Vars.state.isGame() || Vars.player == null) return false;
        var now = Time.globalTime;
        if(now - hintStamp < 8 && now >= hintStamp) return hintValue;
        hintStamp = now;
        hintValue = false;
        try{
            var team = Vars.player.team();
            if(buildMode){
                var landed = landedMachines();
                for(var i = 0; i < landed.length && !hintValue; i++){
                    if(landed[i].team.id == team.id && machineStats(landed[i]).boosters == 0) hintValue = true;
                }
            }else if(poss != null && poss.m.mode == "fly" && poss.m.stats != null){
                hintValue = poss.m.stats.boosters == 0;
            }
        }catch(e){
            logErr("needBoostersHint", e);
        }
        return hintValue;
    }
}
