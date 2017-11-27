module.exports = function (app, socketCallback) {
    // 모든 소켓, 유저id, extra-data, 연결된 소켓들을 저장한다
    var io = require('socket.io');
    var userList = {};
    var isRoomExist = userList['room-id'];  // isRoomExist != null 로 검사할 수 있다
    var shiftedModerationControls = {};

    try {
        io = io(app);
        io.on('connection', onConnection);
    } catch (e) {
        io = io.listen(app, {
            log: false,
            origin: '*:*'
        });

        io.set('transports', [
            'websocket',
            'xhr-polling',
            'jsonp-polling'
        ]);

        io.sockets.on('connection', onConnection);
    }

    // ===== 유저가 방에 들어오면 유저를 추가하는 함수 =====
    function appendUser(socket) {
        var alreadyExist = userList[socket.userid];
        var extra = {};
        var params = socket.handshake.query;

        if (alreadyExist && alreadyExist.extra) {
            extra = alreadyExist.extra;
        }

        if (params.extra) {
            try {
                // offer, answer로 handshake한 타입이 string이면 JSON화해서 저장한다
                if (typeof params.extra === 'string') {
                    params.extra = JSON.parse(params.extra);
                }
                extra = params.extra;
            } catch (e) {
                extra = params.extra;
            }
        }

        userList[socket.userid] = {
            socket: socket,
            connectedWith: {},
            isPublic: false,    // isPublicModerator이라는 뜻
            extra: extra || {},
            maxParticipantsAllowed: params.maxParticipantsAllowed || 100
        };
    }

    // ===== 소켓으로 커넥션하는 함수 =====
    function onConnection(socket) {
        var params = socket.handshake.query;
        var socketMessageEvent = params.msgEvent;   // socketMessageEvent 변수는 roomid를 담는 주머니가 된다
        var sessionid = params.sessionid;
        var autoCloseEntireSession = params.autoCloseEntireSession;

        socket.userid = params.userid;
        appendUser(socket);

        // 중계자가 연결끊기 전에 다른 사람으로 중계자를 바꿔준다
        socket.on('shift-moderator-control-on-disconnect', function() {
            socket.shiftModerationControlBeforeLeaving = true;
        });

        // extra-data를 업데이트한다
        socket.on('extra-data-updated', function(extra) {
            try {
                if (!userList[socket.userid]) return;
                userList[socket.userid].extra = extra;

                for (var user in userList[socket.userid].connectedWith) {
                    userList[user].socket.emit('extra-data-updated', socket.userid, extra);
                }
            } catch (e) {
                pushLogs('extra-data-updated', e);
            }
        });

        // 대화상대의 extra-data를 가져온다
        socket.on('get-remote-user-extra-data', function(remoteUserId, callback) {
            callback = callback || function() {};
            if (!remoteUserId || !userList[remoteUserId]) {
                callback('remoteUserId (' + remoteUserId + ') does NOT exist.');
                return;
            }
            callback(userList[remoteUserId].extra);
        });

        // 파일 전송과 관련된 부분
        socket.on('changed-uuid', function(newUserId, callback) {
            callback = callback || function() {};

            if (params.dontUpdateUserId) {
                delete params.dontUpdateUserId;
                return;
            }

            try {
                if (userList[socket.userid] && userList[socket.userid].socket.userid == socket.userid) {
                    if (newUserId === socket.userid) return;

                    var oldUserId = socket.userid;
                    userList[newUserId] = userList[oldUserId];
                    userList[newUserId].socket.userid = socket.userid = newUserId;
                    delete userList[oldUserId];

                    callback();
                    return;
                }

                socket.userid = newUserId;
                appendUser(socket);

                callback();
            } catch (e) {
                pushLogs('changed-uuid', e);
            }
        });

        // 누군가와 연결이 끊겼을 때
        socket.on('disconnect-with', function(remoteUserId, callback) {
            try {
                if (userList[socket.userid] && userList[socket.userid].connectedWith[remoteUserId]) {
                    delete userList[socket.userid].connectedWith[remoteUserId];
                    socket.emit('user-disconnected', remoteUserId);
                }

                if (!userList[remoteUserId]) return callback();

                if (userList[remoteUserId].connectedWith[socket.userid]) {
                    delete userList[remoteUserId].connectedWith[socket.userid];
                    userList[remoteUserId].socket.emit('user-disconnected', socket.userid);
                }
                callback();
            } catch (e) {
                pushLogs('disconnect-with', e);
            }
        });

        // 전체 세션을 닫는 부분
        socket.on('close-entire-session', function(callback) {
            try {
                var connectedWith = userList[socket.userid].connectedWith;
                Object.keys(connectedWith).forEach(function(key) {
                    if (connectedWith[key] && connectedWith[key].emit) {
                        try {
                            connectedWith[key].emit('closed-entire-session', socket.userid, userList[socket.userid].extra);
                        } catch (e) {}
                    }
                });

                delete shiftedModerationControls[socket.userid];
                callback();
            } catch (e) {
                pushLogs('close-entire-session', e);
            }
        });

        // 방이 이미 만들어져서 존재한지 아닌지 체크
        socket.on('check-presence', function(userid, callback) {
            if (!userList[userid]) {
                callback(false, userid, {});
            } else {
                callback(userid !== socket.userid, userid, userList[userid].extra);
            }
        });

        // 방에 입장
        socket.on(socketMessageEvent, function (message, callback) {
            try {
                if (message.remoteUserId && message.remoteUserId != 'system' && message.message.newParticipationRequest) {
                    if (userList[message.remoteUserId]) {
                        joinRoom(message);
                        return;
                    }
                }

                if (message.message.shiftedModerationControl) {
                    if (!message.message.firedOnLeave) {
                        onMessageCallback(message);
                        return;
                    }
                    shiftedModerationControls[message.sender] = message;
                    return;
                }

                if (!userList[message.sender]) {
                    userList[message.sender] = {
                        socket: socket,
                        connectedWith: {},
                        isPublic: false,
                        extra: {},
                        maxParticipantsAllowed: params.maxParticipantsAllowed || 100
                    };
                }

                // 부재중이던 사람이 방에 들어오려고 시도할 때
                if (message.message.newParticipationRequest) {
                    var waitFor = 60 * 10; // 10분까지는 기다린다
                    var invokedTimes = 0;
                    (function repeater() {
                        if (typeof socket == 'undefined' || !userList[socket.userid]) {
                            return;
                        }

                        invokedTimes++;
                        if (invokedTimes > waitFor) {
                            socket.emit('user-not-found', message.remoteUserId);
                            return;
                        }

                        if (userList[message.remoteUserId] && userList[message.remoteUserId].socket) {
                            joinRoom(message);
                            return;
                        }

                        setTimeout(repeater, 1000);
                    })();

                    return;
                }

                onMessageCallback(message);
            } catch (e) {
                pushLogs('on-socketMessageEvent', e);
            }
        });

        // 방에서 나가 연결끊음
        socket.on('disconnect', function() {
            try {
                if (socket && socket.namespace && socket.namespace.sockets) {
                    delete socket.namespace.sockets[this.id];
                }
            } catch (e) {
                pushLogs('disconnect', e);
            }

            try {
                var message = shiftedModerationControls[socket.userid];

                if (message) {
                    delete shiftedModerationControls[message.userid];
                    onMessageCallback(message);
                }
            } catch (e) {
                pushLogs('disconnect', e);
            }

            try {
                // 연결된 모든 유저에게 알려준다
                if (userList[socket.userid]) {
                    var firstUserSocket = null;

                    for (var s in userList[socket.userid].connectedWith) {
                        if (!firstUserSocket) {
                            firstUserSocket = userList[socket.userid].connectedWith[s];
                        }

                        userList[socket.userid].connectedWith[s].emit('user-disconnected', socket.userid);

                        if (userList[s] && userList[s].connectedWith[socket.userid]) {
                            delete userList[s].connectedWith[socket.userid];
                            userList[s].socket.emit('user-disconnected', socket.userid);
                        }
                    }

                    if (socket.shiftModerationControlBeforeLeaving && firstUserSocket) {
                        firstUserSocket.emit('become-next-modrator', sessionid);
                    }
                }
            } catch (e) {
                pushLogs('disconnect', e);
            }

            delete userList[socket.userid];
        });

        if (socketCallback) {
            socketCallback(socket);
        }

        // ===== 채팅이나 파일이 아닌 데이터를 받는 onmessage 메소드의 콜백함수 =====
        function onMessageCallback(message) {
            try {
                if (!userList[message.sender]) {
                    socket.emit('user-not-found', message.sender);
                    return;
                }

                if (!message.message.userLeft && !userList[message.sender].connectedWith[message.remoteUserId] && !!userList[message.remoteUserId]) {
                    userList[message.sender].connectedWith[message.remoteUserId] = userList[message.remoteUserId].socket;
                    userList[message.sender].socket.emit('user-connected', message.remoteUserId);

                    if (!userList[message.remoteUserId]) {
                        userList[message.remoteUserId] = {
                            socket: null,
                            connectedWith: {},
                            isPublic: false,
                            extra: {},
                            maxParticipantsAllowed: params.maxParticipantsAllowed || 100
                        };
                    }

                    userList[message.remoteUserId].connectedWith[message.sender] = socket;

                    if (userList[message.remoteUserId].socket) {
                        userList[message.remoteUserId].socket.emit('user-connected', message.sender);
                    }
                }

                if (userList[message.sender].connectedWith[message.remoteUserId] && userList[socket.userid]) {
                    message.extra = userList[socket.userid].extra;
                    userList[message.sender].connectedWith[message.remoteUserId].emit(socketMessageEvent, message);
                }
            } catch (e) {
                pushLogs('onMessageCallback', e);
            }
        }

        // ===== 방에 참여하는 함수 =====
        function joinRoom(message) {
            var roomInitiator = userList[message.remoteUserId];

            if (!roomInitiator) {
                return;
            }

            var usersInARoom = roomInitiator.connectedWith;
            var maxParticipantsAllowed = roomInitiator.maxParticipantsAllowed;

            if (Object.keys(usersInARoom).length >= maxParticipantsAllowed) {
                socket.emit('room-full', message.remoteUserId);

                if (roomInitiator.connectedWith[socket.userid]) {
                    delete roomInitiator.connectedWith[socket.userid];
                }
                return;
            }

            var inviteTheseUsers = [roomInitiator.socket];
            Object.keys(usersInARoom).forEach(function(key) {
                inviteTheseUsers.push(usersInARoom[key]);
            });

            var keepUnique = [];
            inviteTheseUsers.forEach(function(userSocket) {
                if (userSocket.userid == socket.userid) return;
                if (keepUnique.indexOf(userSocket.userid) != -1) {
                    return;
                }
                keepUnique.push(userSocket.userid);

                if (params.oneToMany && userSocket.userid !== roomInitiator.socket.userid) return;

                message.remoteUserId = userSocket.userid;
                userSocket.emit(socketMessageEvent, message);
            });
        }

    }

};

// ===== 로그를 json파일로 남기는 함수 =====
function pushLogs() {
    var logsFile = process.cwd() + '/logs.json';
    var utcDateString = (new Date).toUTCString().replace(/ |-|,|:|\./g, '');

    // uncache to fetch recent (up-to-dated)
    uncache(logsFile);

    var logs = {};

    try {
        logs = require(logsFile);
    } catch (e) {}

    if (arguments[1] && arguments[1].stack) {
        arguments[1] = arguments[1].stack;
    }

    try {
        logs[utcDateString] = JSON.stringify(arguments, null, '\t');
        fs.writeFileSync(logsFile, JSON.stringify(logs, null, '\t'));
    } catch (e) {
        logs[utcDateString] = arguments.toString();
    }
}

// ===== 캐시에서 json파일을 지우는 함수 =====
function uncache(jsonFile) {
    searchCache(jsonFile, function(mod) {
        delete require.cache[mod.id];
    });

    Object.keys(module.constructor._pathCache).forEach(function(cacheKey) {
        if (cacheKey.indexOf(jsonFile) > 0) {
            delete module.constructor._pathCache[cacheKey];
        }
    });
}

function searchCache(jsonFile, callback) {
    var mod = require.resolve(jsonFile);

    if (mod && ((mod = require.cache[mod]) !== undefined)) {
        (function run(mod) {
            mod.children.forEach(function(child) {
                run(child);
            });

            callback(mod);
        })(mod);
    }
}