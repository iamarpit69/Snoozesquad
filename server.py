from flask import Flask, send_from_directory, request
from flask_socketio import SocketIO, join_room, leave_room, emit
import uuid
import time
import threading

app = Flask(__name__, static_folder='public')
socketio = SocketIO(app, cors_allowed_origins='*', async_mode='threading')

# In-memory state
rooms = {}
# rooms[code] = {
#   'members': { sid: { 'name': str, 'status': 'asleep'|'awake' } },
#   'proposals': [ { 'id': uuid, 'proposer': name, 'time_utc': epoch_ms, 'label': str, 'votes': [sid] } ],
#   'active_alarm': None | { 'id': uuid, 'time_utc': epoch_ms, 'label': str }
# }

sid_to_room = {}  # maps socket id -> room code

def make_room():
    code = str(uuid.uuid4())[:6].upper()
    rooms[code] = {
        'members': {},
        'proposals': [],
        'active_alarm': None,
    }
    return code

def room_summary(code):
    r = rooms[code]
    return {
        'code': code,
        'members': [
            {'sid': sid, 'name': m['name'], 'status': m['status']}
            for sid, m in r['members'].items()
        ],
        'proposals': r['proposals'],
        'active_alarm': r['active_alarm'],
    }

# ─── Alarm ticker ────────────────────────────────────────────────────────────

def alarm_ticker():
    while True:
        now_ms = int(time.time() * 1000)
        for code, room in list(rooms.items()):
            alarm = room.get('active_alarm')
            if alarm and alarm['time_utc'] <= now_ms and not alarm.get('fired'):
                alarm['fired'] = True
                # Reset all members to asleep so we can track who wakes up
                for sid in room['members']:
                    room['members'][sid]['status'] = 'asleep'
                socketio.emit('alarm_ring', {
                    'alarm_id': alarm['id'],
                    'label': alarm['label'],
                    'time_utc': alarm['time_utc'],
                }, to=code)
                socketio.emit('state_update', room_summary(code), to=code)
        time.sleep(1)

# ─── Socket events ────────────────────────────────────────────────────────────


@socketio.on('create_room')
def on_create_room(data):
    name = data.get('name', 'Anonymous').strip() or 'Anonymous'
    code = make_room()
    rooms[code]['members'][request.sid] = {'name': name, 'status': 'awake'}
    sid_to_room[request.sid] = code
    join_room(code)
    emit('room_joined', {'code': code, 'your_sid': request.sid})
    emit('state_update', room_summary(code))

@socketio.on('join_room_req')
def on_join_room(data):
    name = data.get('name', 'Anonymous').strip() or 'Anonymous'
    code = data.get('code', '').strip().upper()
    if code not in rooms:
        emit('error', {'msg': "That room doesn't exist. Double-check the code — or your friends abandoned you already 😬"})
        return
    rooms[code]['members'][request.sid] = {'name': name, 'status': 'awake'}
    sid_to_room[request.sid] = code
    join_room(code)
    emit('room_joined', {'code': code, 'your_sid': request.sid})
    socketio.emit('state_update', room_summary(code), to=code)

@socketio.on('add_proposal')
def on_add_proposal(data):
    code = sid_to_room.get(request.sid)
    if not code:
        return
    room = rooms[code]
    time_utc = data.get('time_utc')  # epoch ms from client
    label = data.get('label', '').strip() or 'Wake up, sleepyhead 😴'
    proposer = room['members'][request.sid]['name']
    prop = {
        'id': str(uuid.uuid4())[:8],
        'proposer': proposer,
        'time_utc': time_utc,
        'label': label,
        'votes': [request.sid],  # auto-vote for your own proposal
    }
    room['proposals'].append(prop)
    socketio.emit('state_update', room_summary(code), to=code)

@socketio.on('vote_proposal')
def on_vote_proposal(data):
    code = sid_to_room.get(request.sid)
    if not code:
        return
    room = rooms[code]
    prop_id = data.get('prop_id')
    for prop in room['proposals']:
        if prop['id'] == prop_id:
            if request.sid not in prop['votes']:
                prop['votes'].append(request.sid)
            else:
                prop['votes'].remove(request.sid)  # toggle vote
            break
    # Check majority: if a proposal has > half the members, activate it
    total = len(room['members'])
    for prop in room['proposals']:
        if len(prop['votes']) > total / 2 and room['active_alarm'] is None:
            room['active_alarm'] = {
                'id': prop['id'],
                'time_utc': prop['time_utc'],
                'label': prop['label'],
                'fired': False,
            }
            room['proposals'] = []  # clear proposals once alarm is set
            socketio.emit('alarm_set', {
                'alarm': room['active_alarm'],
            }, to=code)
            break
    socketio.emit('state_update', room_summary(code), to=code)

@socketio.on('cancel_alarm')
def on_cancel_alarm(data):
    code = sid_to_room.get(request.sid)
    if not code:
        return
    rooms[code]['active_alarm'] = None
    socketio.emit('alarm_cancelled', {}, to=code)
    socketio.emit('state_update', room_summary(code), to=code)

@socketio.on('dismiss_alarm')
def on_dismiss_alarm(data):
    code = sid_to_room.get(request.sid)
    if not code or code not in rooms:
        return
    room = rooms[code]
    if request.sid in room['members']:
        room['members'][request.sid]['status'] = 'awake'
    # Check if ALL have dismissed → clear active alarm
    all_awake = all(m['status'] == 'awake' for m in room['members'].values())
    if all_awake and room['active_alarm']:
        room['active_alarm'] = None
    socketio.emit('state_update', room_summary(code), to=code)

@socketio.on('disconnect')
def on_disconnect():
    code = sid_to_room.pop(request.sid, None)
    if code and code in rooms:
        rooms[code]['members'].pop(request.sid, None)
        # Clean up votes
        for prop in rooms[code]['proposals']:
            if request.sid in prop['votes']:
                prop['votes'].remove(request.sid)
        if not rooms[code]['members']:
            del rooms[code]  # last one out, lights off
        else:
            socketio.emit('state_update', room_summary(code), to=code)

# ─── Serve frontend ──────────────────────────────────────────────────────────

@app.route('/')
def index():
    return send_from_directory('public', 'index.html')

@app.route('/<path:path>')
def static_files(path):
    return send_from_directory('public', path)

# ─── Main ─────────────────────────────────────────────────────────────────────

def start_tunnel(port):
    """Open a free public tunnel via localhost.run (no account needed)."""
    import subprocess, re, sys
    try:
        proc = subprocess.Popen(
            ['ssh', '-o', 'StrictHostKeyChecking=no', '-R', f'80:localhost:{port}',
             'nokey@localhost.run', '--', '--output=text'],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True
        )
        print("\n  Creating public link... (takes ~5 seconds)", flush=True)
        for line in proc.stdout:
            # localhost.run prints: "xxx tunneled with tls termination, https://xxx.lhr.life"
            match = re.search(r'https://\S+\.lhr\.life', line)
            if match:
                url = match.group(0).rstrip('.')
                print("\n" + "=" * 60, flush=True)
                print("  SNOOZESQUAD IS LIVE!", flush=True)
                print(f"\n  Share this link with your friends:\n", flush=True)
                print(f"  --> {url}\n", flush=True)
                print("  They can open it from anywhere in the world.", flush=True)
                print("=" * 60 + "\n", flush=True)
                break
    except Exception as e:
        print(f"\n  [tunnel] Could not create public URL: {e}", flush=True)
        print(f"  Local URL: http://localhost:{port}", flush=True)

if __name__ == '__main__':
    import os
    port = int(os.environ.get('PORT', 3000))
    is_production = os.environ.get('RAILWAY_ENVIRONMENT') or os.environ.get('RENDER')

    t = threading.Thread(target=alarm_ticker, daemon=True)
    t.start()

    if not is_production:
        tunnel_thread = threading.Thread(target=start_tunnel, args=(port,), daemon=True)
        tunnel_thread.start()
    else:
        print(f"SnoozeSquad running in production on port {port}")

    socketio.run(app, host='0.0.0.0', port=port, debug=False, allow_unsafe_werkzeug=True)
