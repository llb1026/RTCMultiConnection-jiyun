'use strict';

window.RTCMultiConnection = function(roomid, forceOptions) {

    function SocketConnection(connection, connectCallback) {
        var parameters = '';

        parameters += '?userid=' + connection.userid;
        parameters += '&sessionid=' + connection.sessionid;
        parameters += '&msgEvent=' + connection.socketMessageEvent;
        parameters += '&autoCloseEntireSession=' + !!connection.autoCloseEntireSession;

        if (connection.session.broadcast === true) {
            parameters += '&oneToMany=true';
        }

        parameters += '&maxParticipantsAllowed=' + connection.maxParticipantsAllowed;

        if (connection.enableScalableBroadcast) {
            parameters += '&enableScalableBroadcast=true';
            parameters += '&maxRelayLimitPerUser=' + (connection.maxRelayLimitPerUser || 2);
        }

        try {
            io.sockets = {};
        } catch (e) {};

        if (!connection.socketURL) {
            connection.socketURL = '/';
        }

        if (connection.socketURL.substr(connection.socketURL.length - 1, 1) != '/') {
            // connection.socketURL = 'https://domain.com:3000/';
            throw '"socketURL" MUST end with a slash.';
        }

        if (connection.socketURL == '/') {
            console.info(location.origin + '/ 에 socket.io가 연결되었습니다');
        } else {
            console.info(connection.socketURL + '에 socket.io가 연결되었습니다');
        }

        try {
            connection.socket = io(connection.socketURL + parameters);
        } catch (e) {
            connection.socket = io.connect(connection.socketURL + parameters, connection.socketOptions);
        }

        // detect signaling medium
        connection.socket.isIO = true;

        var mPeer = connection.multiPeersHandler;

        connection.socket.on('extra-data-updated', function(remoteUserId, extra) {
            if (!connection.peers[remoteUserId]) return;
            connection.peers[remoteUserId].extra = extra;

            connection.onExtraDataUpdated({
                userid: remoteUserId,
                extra: extra
            });

            if (!connection.peersBackup[remoteUserId]) {
                connection.peersBackup[remoteUserId] = {
                    userid: remoteUserId,
                    extra: {}
                };
            }

            connection.peersBackup[remoteUserId].extra = extra;
        });

        connection.socket.on(connection.socketMessageEvent, function(message) {
            if (message.remoteUserId != connection.userid) return;

            if (connection.peers[message.sender] && connection.peers[message.sender].extra != message.message.extra) {
                connection.peers[message.sender].extra = message.extra;
                connection.onExtraDataUpdated({
                    userid: message.sender,
                    extra: message.extra
                });
            }

            if (message.message.streamSyncNeeded && connection.peers[message.sender]) {
                var stream = connection.streamEvents[message.message.streamid];
                if (!stream || !stream.stream) {
                    return;
                }

                var action = message.message.action;

                if (action === 'ended' || action === 'inactive' || action === 'stream-removed') {
                    if (connection.peersBackup[stream.userid]) {
                        stream.extra = connection.peersBackup[stream.userid].extra;
                    }
                    connection.onstreamended(stream);
                    return;
                }

                var type = message.message.type != 'both' ? message.message.type : null;

                if (typeof stream.stream[action] == 'function') {
                    stream.stream[action](type);
                }
                return;
            }

            if (message.message === 'connectWithAllParticipants') {
                if (connection.broadcasters.indexOf(message.sender) === -1) {
                    connection.broadcasters.push(message.sender);
                }

                mPeer.onNegotiationNeeded({
                    allParticipants: connection.getAllParticipants(message.sender)
                }, message.sender);
                return;
            }

            if (message.message === 'removeFromBroadcastersList') {
                if (connection.broadcasters.indexOf(message.sender) !== -1) {
                    delete connection.broadcasters[connection.broadcasters.indexOf(message.sender)];
                    connection.broadcasters = removeNullEntries(connection.broadcasters);
                }
                return;
            }

            if (message.message === 'dropPeerConnection') {
                connection.deletePeer(message.sender);
                return;
            }

            if (message.message.allParticipants) {
                if (message.message.allParticipants.indexOf(message.sender) === -1) {
                    message.message.allParticipants.push(message.sender);
                }

                message.message.allParticipants.forEach(function(participant) {
                    mPeer[!connection.peers[participant] ? 'createNewPeer' : 'renegotiatePeer'](participant, {
                        localPeerSdpConstraints: {
                            OfferToReceiveAudio: connection.sdpConstraints.mandatory.OfferToReceiveAudio,
                            OfferToReceiveVideo: connection.sdpConstraints.mandatory.OfferToReceiveVideo
                        },
                        remotePeerSdpConstraints: {
                            OfferToReceiveAudio: connection.session.oneway ? !!connection.session.audio : connection.sdpConstraints.mandatory.OfferToReceiveAudio,
                            OfferToReceiveVideo: connection.session.oneway ? !!connection.session.video || !!connection.session.screen : connection.sdpConstraints.mandatory.OfferToReceiveVideo
                        },
                        isOneWay: !!connection.session.oneway || connection.direction === 'one-way',
                        isDataOnly: isData(connection.session)
                    });
                });
                return;
            }

            if (message.message.newParticipant) {
                if (message.message.newParticipant == connection.userid) return;
                if (!!connection.peers[message.message.newParticipant]) return;

                mPeer.createNewPeer(message.message.newParticipant, message.message.userPreferences || {
                    localPeerSdpConstraints: {
                        OfferToReceiveAudio: connection.sdpConstraints.mandatory.OfferToReceiveAudio,
                        OfferToReceiveVideo: connection.sdpConstraints.mandatory.OfferToReceiveVideo
                    },
                    remotePeerSdpConstraints: {
                        OfferToReceiveAudio: connection.session.oneway ? !!connection.session.audio : connection.sdpConstraints.mandatory.OfferToReceiveAudio,
                        OfferToReceiveVideo: connection.session.oneway ? !!connection.session.video || !!connection.session.screen : connection.sdpConstraints.mandatory.OfferToReceiveVideo
                    },
                    isOneWay: !!connection.session.oneway || connection.direction === 'one-way',
                    isDataOnly: isData(connection.session)
                });
                return;
            }

            if (message.message.readyForOffer || message.message.addMeAsBroadcaster) {
                connection.addNewBroadcaster(message.sender);
            }

            if (message.message.newParticipationRequest && message.sender !== connection.userid) {
                if (connection.peers[message.sender]) {
                    connection.deletePeer(message.sender);
                }

                var userPreferences = {
                    extra: message.extra || {},
                    localPeerSdpConstraints: message.message.remotePeerSdpConstraints || {
                        OfferToReceiveAudio: connection.sdpConstraints.mandatory.OfferToReceiveAudio,
                        OfferToReceiveVideo: connection.sdpConstraints.mandatory.OfferToReceiveVideo
                    },
                    remotePeerSdpConstraints: message.message.localPeerSdpConstraints || {
                        OfferToReceiveAudio: connection.session.oneway ? !!connection.session.audio : connection.sdpConstraints.mandatory.OfferToReceiveAudio,
                        OfferToReceiveVideo: connection.session.oneway ? !!connection.session.video || !!connection.session.screen : connection.sdpConstraints.mandatory.OfferToReceiveVideo
                    },
                    isOneWay: typeof message.message.isOneWay !== 'undefined' ? message.message.isOneWay : !!connection.session.oneway || connection.direction === 'one-way',
                    isDataOnly: typeof message.message.isDataOnly !== 'undefined' ? message.message.isDataOnly : isData(connection.session),
                    dontGetRemoteStream: typeof message.message.isOneWay !== 'undefined' ? message.message.isOneWay : !!connection.session.oneway || connection.direction === 'one-way',
                    dontAttachLocalStream: !!message.message.dontGetRemoteStream,
                    connectionDescription: message,
                    successCallback: function() {
                        // if its oneway----- todo: THIS SEEMS NOT IMPORTANT.
                        if (typeof message.message.isOneWay !== 'undefined' ? message.message.isOneWay : !!connection.session.oneway || connection.direction === 'one-way') {
                            connection.addNewBroadcaster(message.sender, userPreferences);
                        }

                        if (!!connection.session.oneway || connection.direction === 'one-way' || isData(connection.session)) {
                            connection.addNewBroadcaster(message.sender, userPreferences);
                        }
                    }
                };

                connection.onNewParticipant(message.sender, userPreferences);
                return;
            }

            if (message.message.shiftedModerationControl) {
                connection.onShiftedModerationControl(message.sender, message.message.broadcasters);
                return;
            }

            if (message.message.changedUUID) {
                if (connection.peers[message.message.oldUUID]) {
                    connection.peers[message.message.newUUID] = connection.peers[message.message.oldUUID];
                    delete connection.peers[message.message.oldUUID];
                }
            }

            if (message.message.userLeft) {
                mPeer.onUserLeft(message.sender);

                if (!!message.message.autoCloseEntireSession) {
                    connection.leave();
                }

                return;
            }

            mPeer.addNegotiatedMessage(message.message, message.sender);
        });

        connection.socket.on('user-left', function(userid) {
            onUserLeft(userid);

            connection.onUserStatusChanged({
                userid: userid,
                status: 'offline',
                extra: connection.peers[userid] ? connection.peers[userid].extra || {} : {}
            });

            var eventObject = {
                userid: userid,
                extra: {}
            };

            if (connection.peersBackup[eventObject.userid]) {
                eventObject.extra = connection.peersBackup[eventObject.userid].extra;
            }

            connection.onleave(eventObject);
        });

        var alreadyConnected = false;

        connection.socket.resetProps = function() {
            alreadyConnected = false;
        };

        connection.socket.on('connect', function() {
            if (alreadyConnected) {
                return;
            }
            alreadyConnected = true;

            console.info('socket.io 커넥션이 열려있습니다');

            setTimeout(function() {
                connection.socket.emit('extra-data-updated', connection.extra);

                if (connectCallback) {
                    connectCallback(connection.socket);
                }
            }, 1000);
        });

        connection.socket.on('disconnect', function() {
            console.warn('socket.io 커넥션이 닫혔습니다');
        });

        connection.socket.on('join-with-password', function(remoteUserId) {
            connection.onJoinWithPassword(remoteUserId);
        });

        connection.socket.on('invalid-password', function(remoteUserId, oldPassword) {
            connection.onInvalidPassword(remoteUserId, oldPassword);
        });

        connection.socket.on('password-max-tries-over', function(remoteUserId) {
            connection.onPasswordMaxTriesOver(remoteUserId);
        });

        connection.socket.on('user-disconnected', function(remoteUserId) {
            if (remoteUserId === connection.userid) {
                return;
            }

            connection.onUserStatusChanged({
                userid: remoteUserId,
                status: 'offline',
                extra: connection.peers[remoteUserId] ? connection.peers[remoteUserId].extra || {} : {}
            });

            connection.deletePeer(remoteUserId);
        });

        connection.socket.on('user-connected', function(userid) {
            if (userid === connection.userid) {
                return;
            }

            connection.onUserStatusChanged({
                userid: userid,
                status: 'online',
                extra: connection.peers[userid] ? connection.peers[userid].extra || {} : {}
            });
        });

        connection.socket.on('closed-entire-session', function(sessionid, extra) {
            connection.leave();
            connection.onEntireSessionClosed({
                sessionid: sessionid,
                userid: sessionid,
                extra: extra
            });
        });

        connection.socket.on('userid-already-taken', function(useridAlreadyTaken, yourNewUserId) {
            connection.isInitiator = false;
            connection.userid = yourNewUserId;

            connection.onUserIdAlreadyTaken(useridAlreadyTaken, yourNewUserId);
        })

        connection.socket.on('logs', function(log) {
            console.debug('server-logs', log);
        });

        connection.socket.on('number-of-broadcast-viewers-updated', function(data) {
            connection.onNumberOfBroadcastViewersUpdated(data);
        });

        connection.socket.on('room-full', function(roomid) {
            connection.onRoomFull(roomid);
        });

        connection.socket.on('become-next-modrator', function(sessionid) {
            if (sessionid != connection.sessionid) return;
            setTimeout(function() {
                connection.open(sessionid);
                connection.socket.emit('shift-moderator-control-on-disconnect');
            }, 1000);
        });
    }

    function MultiPeers(connection) {
        var self = this;

        var skipPeers = ['getAllParticipants', 'getLength', 'selectFirst', 'streams', 'send', 'forEach'];
        connection.peersBackup = {};
        connection.peers = {
            getLength: function() {
                var numberOfPeers = 0;
                for (var peer in this) {
                    if (skipPeers.indexOf(peer) == -1) {
                        numberOfPeers++;
                    }
                }
                return numberOfPeers;
            },
            selectFirst: function() {
                var firstPeer;
                for (var peer in this) {
                    if (skipPeers.indexOf(peer) == -1) {
                        firstPeer = this[peer];
                    }
                }
                return firstPeer;
            },
            getAllParticipants: function(sender) {
                var allPeers = [];
                for (var peer in this) {
                    if (skipPeers.indexOf(peer) == -1 && peer != sender) {
                        allPeers.push(peer);
                    }
                }
                return allPeers;
            },
            forEach: function(callbcak) {
                this.getAllParticipants().forEach(function(participant) {
                    callbcak(connection.peers[participant]);
                });
            },
            send: function(data, remoteUserId) {
                var that = this;

                if (!isNull(data.size) && !isNull(data.type)) {
                    self.shareFile(data, remoteUserId);
                    return;
                }

                if (data.type !== 'text' && !(data instanceof ArrayBuffer) && !(data instanceof DataView)) {
                    TextSender.send({
                        text: data,
                        channel: this,
                        connection: connection,
                        remoteUserId: remoteUserId
                    });
                    return;
                }

                if (data.type === 'text') {
                    data = JSON.stringify(data);
                }

                if (remoteUserId) {
                    var remoteUser = connection.peers[remoteUserId];
                    if (remoteUser) {
                        if (!remoteUser.channels.length) {
                            connection.peers[remoteUserId].createDataChannel();
                            connection.renegotiate(remoteUserId);
                            setTimeout(function() {
                                that.send(data, remoteUserId);
                            }, 3000);
                            return;
                        }

                        remoteUser.channels.forEach(function(channel) {
                            channel.send(data);
                        });
                        return;
                    }
                }

                this.getAllParticipants().forEach(function(participant) {
                    if (!that[participant].channels.length) {
                        connection.peers[participant].createDataChannel();
                        connection.renegotiate(participant);
                        setTimeout(function() {
                            that[participant].channels.forEach(function(channel) {
                                channel.send(data);
                            });
                        }, 3000);
                        return;
                    }

                    that[participant].channels.forEach(function(channel) {
                        channel.send(data);
                    });
                });
            }
        };

        this.uuid = connection.userid;

        this.getLocalConfig = function(remoteSdp, remoteUserId, userPreferences) {
            if (!userPreferences) {
                userPreferences = {};
            }

            return {
                streamsToShare: userPreferences.streamsToShare || {},
                rtcMultiConnection: connection,
                connectionDescription: userPreferences.connectionDescription,
                userid: remoteUserId,
                localPeerSdpConstraints: userPreferences.localPeerSdpConstraints,
                remotePeerSdpConstraints: userPreferences.remotePeerSdpConstraints,
                dontGetRemoteStream: !!userPreferences.dontGetRemoteStream,
                dontAttachLocalStream: !!userPreferences.dontAttachLocalStream,
                renegotiatingPeer: !!userPreferences.renegotiatingPeer,
                peerRef: userPreferences.peerRef,
                channels: userPreferences.channels || [],
                onLocalSdp: function(localSdp) {
                    self.onNegotiationNeeded(localSdp, remoteUserId);
                },
                onLocalCandidate: function(localCandidate) {
                    localCandidate = OnIceCandidateHandler.processCandidates(connection, localCandidate)
                    if (localCandidate) {
                        self.onNegotiationNeeded(localCandidate, remoteUserId);
                    }
                },
                remoteSdp: remoteSdp,
                onDataChannelMessage: function(message) {
                    if (!connection.fbr && connection.enableFileSharing) initFileBufferReader();

                    if (typeof message == 'string' || !connection.enableFileSharing) {
                        self.onDataChannelMessage(message, remoteUserId);
                        return;
                    }

                    var that = this;

                    if (message instanceof ArrayBuffer || message instanceof DataView) {
                        connection.fbr.convertToObject(message, function(object) {
                            that.onDataChannelMessage(object);
                        });
                        return;
                    }

                    if (message.readyForNextChunk) {
                        connection.fbr.getNextChunk(message, function(nextChunk, isLastChunk) {
                            connection.peers[remoteUserId].channels.forEach(function(channel) {
                                channel.send(nextChunk);
                            });
                        }, remoteUserId);
                        return;
                    }

                    if (message.chunkMissing) {
                        connection.fbr.chunkMissing(message);
                        return;
                    }

                    connection.fbr.addChunk(message, function(promptNextChunk) {
                        connection.peers[remoteUserId].peer.channel.send(promptNextChunk);
                    });
                },
                onDataChannelError: function(error) {
                    self.onDataChannelError(error, remoteUserId);
                },
                onDataChannelOpened: function(channel) {
                    self.onDataChannelOpened(channel, remoteUserId);
                },
                onDataChannelClosed: function(event) {
                    self.onDataChannelClosed(event, remoteUserId);
                },
                onRemoteStream: function(stream) {
                    if (connection.peers[remoteUserId]) {
                        connection.peers[remoteUserId].streams.push(stream);
                    }

                    self.onGettingRemoteMedia(stream, remoteUserId);
                },
                onRemoteStreamRemoved: function(stream) {
                    self.onRemovingRemoteMedia(stream, remoteUserId);
                },
                onPeerStateChanged: function(states) {
                    self.onPeerStateChanged(states);

                    if (states.iceConnectionState === 'new') {
                        self.onNegotiationStarted(remoteUserId, states);
                    }

                    if (states.iceConnectionState === 'connected') {
                        self.onNegotiationCompleted(remoteUserId, states);
                    }

                    if (states.iceConnectionState.search(/closed|failed/gi) !== -1) {
                        self.onUserLeft(remoteUserId);
                        self.disconnectWith(remoteUserId);
                    }
                }
            };
        };

        this.createNewPeer = function(remoteUserId, userPreferences) {
            if (connection.maxParticipantsAllowed <= connection.getAllParticipants().length) {
                return;
            }

            userPreferences = userPreferences || {};

            if (connection.isInitiator && !!connection.session.audio && connection.session.audio === 'two-way' && !userPreferences.streamsToShare) {
                userPreferences.isOneWay = false;
                userPreferences.isDataOnly = false;
                userPreferences.session = connection.session;
            }

            if (!userPreferences.isOneWay && !userPreferences.isDataOnly) {
                userPreferences.isOneWay = true;
                this.onNegotiationNeeded({
                    enableMedia: true,
                    userPreferences: userPreferences
                }, remoteUserId);
                return;
            }

            userPreferences = connection.setUserPreferences(userPreferences, remoteUserId);
            var localConfig = this.getLocalConfig(null, remoteUserId, userPreferences);
            connection.peers[remoteUserId] = new PeerInitiator(localConfig);
        };

        this.createAnsweringPeer = function(remoteSdp, remoteUserId, userPreferences) {
            userPreferences = connection.setUserPreferences(userPreferences || {}, remoteUserId);

            var localConfig = this.getLocalConfig(remoteSdp, remoteUserId, userPreferences);
            connection.peers[remoteUserId] = new PeerInitiator(localConfig);
        };

        this.renegotiatePeer = function(remoteUserId, userPreferences, remoteSdp) {
            if (!connection.peers[remoteUserId]) {
                console.error('피어 (' + remoteUserId + ') 가 존재하지 않습니다. 재협상이 스킵되었습니다.');
                return;
            }

            if (!userPreferences) {
                userPreferences = {};
            }

            userPreferences.renegotiatingPeer = true;
            userPreferences.peerRef = connection.peers[remoteUserId].peer;
            userPreferences.channels = connection.peers[remoteUserId].channels;

            var localConfig = this.getLocalConfig(remoteSdp, remoteUserId, userPreferences);

            connection.peers[remoteUserId] = new PeerInitiator(localConfig);
        };

        this.replaceTrack = function(track, remoteUserId, isVideoTrack) {
            if (!connection.peers[remoteUserId]) {
                throw 'This peer (' + remoteUserId + ') does not exist.';
            }

            var peer = connection.peers[remoteUserId].peer;

            if (!!peer.getSenders && typeof peer.getSenders === 'function' && peer.getSenders().length) {
                peer.getSenders().forEach(function(rtpSender) {
                    if (isVideoTrack && rtpSender.track instanceof VideoStreamTrack) {
                        connection.peers[remoteUserId].peer.lastVideoTrack = rtpSender.track;
                        rtpSender.replaceTrack(track);
                    }

                    if (!isVideoTrack && rtpSender.track instanceof AudioStreamTrack) {
                        connection.peers[remoteUserId].peer.lastAudioTrack = rtpSender.track;
                        rtpSender.replaceTrack(track);
                    }
                });
                return;
            }

            console.warn('RTPSender.replaceTrack is NOT supported.');
            this.renegotiatePeer(remoteUserId);
        };

        this.onNegotiationNeeded = function(message, remoteUserId) {};
        this.addNegotiatedMessage = function(message, remoteUserId) {
            if (message.type && message.sdp) {
                if (message.type == 'answer') {
                    if (connection.peers[remoteUserId]) {
                        connection.peers[remoteUserId].addRemoteSdp(message);
                    }
                }

                if (message.type == 'offer') {
                    if (message.renegotiatingPeer) {
                        this.renegotiatePeer(remoteUserId, null, message);
                    } else {
                        this.createAnsweringPeer(message, remoteUserId);
                    }
                }

                console.log('리모트 피어의 SDP: ', message.sdp);
                return;
            }

            if (message.candidate) {
                if (connection.peers[remoteUserId]) {
                    connection.peers[remoteUserId].addRemoteCandidate(message);
                }

                console.log('리모트 피어의 후보 페어들: ', message.candidate);
                return;
            }

            if (message.enableMedia) {
                connection.session = message.userPreferences.session || connection.session;

                if (connection.session.oneway && connection.attachStreams.length) {
                    connection.attachStreams = [];
                }

                if (message.userPreferences.isDataOnly && connection.attachStreams.length) {
                    connection.attachStreams.length = [];
                }

                var streamsToShare = {};
                connection.attachStreams.forEach(function(stream) {
                    streamsToShare[stream.streamid] = {
                        isAudio: !!stream.isAudio,
                        isVideo: !!stream.isVideo,
                        isScreen: !!stream.isScreen
                    };
                });
                message.userPreferences.streamsToShare = streamsToShare;

                self.onNegotiationNeeded({
                    readyForOffer: true,
                    userPreferences: message.userPreferences
                }, remoteUserId);
            }

            if (message.readyForOffer) {
                connection.onReadyForOffer(remoteUserId, message.userPreferences);
            }

            function cb(stream) {
                gumCallback(stream, message, remoteUserId);
            }
        };

        function gumCallback(stream, message, remoteUserId) {
            var streamsToShare = {};
            connection.attachStreams.forEach(function(stream) {
                streamsToShare[stream.streamid] = {
                    isAudio: !!stream.isAudio,
                    isVideo: !!stream.isVideo,
                    isScreen: !!stream.isScreen
                };
            });
            message.userPreferences.streamsToShare = streamsToShare;

            self.onNegotiationNeeded({
                readyForOffer: true,
                userPreferences: message.userPreferences
            }, remoteUserId);
        }

        this.connectNewParticipantWithAllBroadcasters = function(newParticipantId, userPreferences, broadcastersList) {
            if (connection.socket.isIO) {
                return;
            }

            broadcastersList = (broadcastersList || '').split('|-,-|');

            if (!broadcastersList.length) {
                return;
            }

            var firstBroadcaster;

            var remainingBroadcasters = [];
            broadcastersList.forEach(function(list) {
                list = (list || '').replace(/ /g, '');
                if (list.length) {
                    if (!firstBroadcaster) {
                        firstBroadcaster = list;
                    } else {
                        remainingBroadcasters.push(list);
                    }
                }
            });

            if (!firstBroadcaster) {
                return;
            }

            self.onNegotiationNeeded({
                newParticipant: newParticipantId,
                userPreferences: userPreferences || false
            }, firstBroadcaster);

            if (!remainingBroadcasters.length) {
                return;
            }

            setTimeout(function() {
                self.connectNewParticipantWithAllBroadcasters(newParticipantId, userPreferences, remainingBroadcasters.join('|-,-|'));
            }, 3 * 1000);
        };

        this.onGettingRemoteMedia = function(stream, remoteUserId) {};
        this.onRemovingRemoteMedia = function(stream, remoteUserId) {};
        this.onGettingLocalMedia = function(localStream) {};
        this.onLocalMediaError = function(error, constraints) {
            connection.onMediaError(error, constraints);
        };

        function initFileBufferReader() {
            connection.fbr = new FileBufferReader();
            connection.fbr.onProgress = function(chunk) {
                connection.onFileProgress(chunk);
            };
            connection.fbr.onBegin = function(file) {
                connection.onFileStart(file);
            };
            connection.fbr.onEnd = function(file) {
                connection.onFileEnd(file);
            };
        }

        this.shareFile = function(file, remoteUserId) {
            if (!connection.enableFileSharing) {
                throw '"connection.enableFileSharing" is false.';
            }

            initFileBufferReader();

            connection.fbr.readAsArrayBuffer(file, function(uuid) {
                var arrayOfUsers = connection.getAllParticipants();

                if (remoteUserId) {
                    arrayOfUsers = [remoteUserId];
                }

                arrayOfUsers.forEach(function(participant) {
                    connection.fbr.getNextChunk(uuid, function(nextChunk) {
                        connection.peers[participant].channels.forEach(function(channel) {
                            channel.send(nextChunk);
                        });
                    }, participant);
                });
            }, {
                userid: connection.userid,
                // extra: connection.extra,
                chunkSize: DetectRTC.browser.name === 'Firefox' ? 15 * 1000 : connection.chunkSize || 0
            });
        };

        if (typeof 'TextReceiver' !== 'undefined') {
            var textReceiver = new TextReceiver(connection);
        }

        this.onDataChannelMessage = function(message, remoteUserId) {
            textReceiver.receive(JSON.parse(message), remoteUserId, connection.peers[remoteUserId] ? connection.peers[remoteUserId].extra : {});
        };

        this.onDataChannelClosed = function(event, remoteUserId) {
            event.userid = remoteUserId;
            event.extra = connection.peers[remoteUserId] ? connection.peers[remoteUserId].extra : {};
            connection.onclose(event);
        };

        this.onDataChannelError = function(error, remoteUserId) {
            error.userid = remoteUserId;
            event.extra = connection.peers[remoteUserId] ? connection.peers[remoteUserId].extra : {};
            connection.onerror(error);
        };

        this.onDataChannelOpened = function(channel, remoteUserId) {
            // keep last channel only; we are not expecting parallel/channels channels
            if (connection.peers[remoteUserId].channels.length) {
                connection.peers[remoteUserId].channels = [channel];
                return;
            }

            connection.peers[remoteUserId].channels.push(channel);
            connection.onopen({
                userid: remoteUserId,
                extra: connection.peers[remoteUserId] ? connection.peers[remoteUserId].extra : {},
                channel: channel
            });
        };

        this.onPeerStateChanged = function(state) {
            connection.onPeerStateChanged(state);
        };

        this.onNegotiationStarted = function(remoteUserId, states) {};
        this.onNegotiationCompleted = function(remoteUserId, states) {};

        this.getRemoteStreams = function(remoteUserId) {
            remoteUserId = remoteUserId || connection.peers.getAllParticipants()[0];
            return connection.peers[remoteUserId] ? connection.peers[remoteUserId].streams : [];
        };
    }

    'use strict';

    // Last Updated On: 2017-08-31 6:52:39 AM UTC

    // ________________
    // DetectRTC v1.3.5

    // Open-Sourced: https://github.com/muaz-khan/DetectRTC

    // --------------------------------------------------
    // Muaz Khan     - www.MuazKhan.com
    // MIT License   - www.WebRTC-Experiment.com/licence
    // --------------------------------------------------

    (function() {

        var browserFakeUserAgent = 'Fake/5.0 (FakeOS) AppleWebKit/123 (KHTML, like Gecko) Fake/12.3.4567.89 Fake/123.45';

        var isNodejs = typeof process === 'object' && typeof process.versions === 'object' && process.versions.node && /*node-process*/ !process.browser;
        if (isNodejs) {
            var version = process.versions.node.toString().replace('v', '');
            browserFakeUserAgent = 'Nodejs/' + version + ' (NodeOS) AppleWebKit/' + version + ' (KHTML, like Gecko) Nodejs/' + version + ' Nodejs/' + version
        }

        (function(that) {
            if (typeof window !== 'undefined') {
                return;
            }

            if (typeof window === 'undefined' && typeof global !== 'undefined') {
                global.navigator = {
                    userAgent: browserFakeUserAgent,
                    getUserMedia: function() {}
                };

                /*global window:true */
                that.window = global;
            } else if (typeof window === 'undefined') {
                // window = this;
            }

            if (typeof location === 'undefined') {
                /*global location:true */
                that.location = {
                    protocol: 'file:',
                    href: '',
                    hash: ''
                };
            }

            if (typeof screen === 'undefined') {
                /*global screen:true */
                that.screen = {
                    width: 0,
                    height: 0
                };
            }
        })(typeof global !== 'undefined' ? global : window);

        /*global navigator:true */
        var navigator = window.navigator;

        if (typeof navigator !== 'undefined') {
            if (typeof navigator.webkitGetUserMedia !== 'undefined') {
                navigator.getUserMedia = navigator.webkitGetUserMedia;
            }

            if (typeof navigator.mozGetUserMedia !== 'undefined') {
                navigator.getUserMedia = navigator.mozGetUserMedia;
            }
        } else {
            navigator = {
                getUserMedia: function() {},
                userAgent: browserFakeUserAgent
            };
        }

        var isMobileDevice = !!(/Android|webOS|iPhone|iPad|iPod|BB10|BlackBerry|IEMobile|Opera Mini|Mobile|mobile/i.test(navigator.userAgent || ''));

        var isEdge = navigator.userAgent.indexOf('Edge') !== -1 && (!!navigator.msSaveOrOpenBlob || !!navigator.msSaveBlob);

        var isOpera = !!window.opera || navigator.userAgent.indexOf(' OPR/') >= 0;
        var isFirefox = typeof window.InstallTrigger !== 'undefined';
        var isSafari = Object.prototype.toString.call(window.HTMLElement).indexOf('Constructor') > 0;
        var isChrome = !!window.chrome && !isOpera;
        var isIE = typeof document !== 'undefined' && !!document.documentMode && !isEdge;

        // this one can also be used:
        // https://www.websocket.org/js/stuff.js (DetectBrowser.js)

        function getBrowserInfo() {
            var nVer = navigator.appVersion;
            var nAgt = navigator.userAgent;
            var browserName = navigator.appName;
            var fullVersion = '' + parseFloat(navigator.appVersion);
            var majorVersion = parseInt(navigator.appVersion, 10);
            var nameOffset, verOffset, ix;

            // In Opera, the true version is after 'Opera' or after 'Version'
            if (isOpera) {
                browserName = 'Opera';
                try {
                    fullVersion = navigator.userAgent.split('OPR/')[1].split(' ')[0];
                    majorVersion = fullVersion.split('.')[0];
                } catch (e) {
                    fullVersion = '0.0.0.0';
                    majorVersion = 0;
                }
            }
            // In MSIE version <=10, the true version is after 'MSIE' in userAgent
            // In IE 11, look for the string after 'rv:'
            else if (isIE) {
                verOffset = nAgt.indexOf('rv:');
                if (verOffset > 0) { //IE 11
                    fullVersion = nAgt.substring(verOffset + 3);
                } else { //IE 10 or earlier
                    verOffset = nAgt.indexOf('MSIE');
                    fullVersion = nAgt.substring(verOffset + 5);
                }
                browserName = 'IE';
            }
            // In Chrome, the true version is after 'Chrome'
            else if (isChrome) {
                verOffset = nAgt.indexOf('Chrome');
                browserName = 'Chrome';
                fullVersion = nAgt.substring(verOffset + 7);
            }
            // In Safari, the true version is after 'Safari' or after 'Version'
            else if (isSafari) {
                verOffset = nAgt.indexOf('Safari');
                browserName = 'Safari';
                fullVersion = nAgt.substring(verOffset + 7);

                if ((verOffset = nAgt.indexOf('Version')) !== -1) {
                    fullVersion = nAgt.substring(verOffset + 8);
                }
            }
            // In Firefox, the true version is after 'Firefox'
            else if (isFirefox) {
                verOffset = nAgt.indexOf('Firefox');
                browserName = 'Firefox';
                fullVersion = nAgt.substring(verOffset + 8);
            }

            // In most other browsers, 'name/version' is at the end of userAgent
            else if ((nameOffset = nAgt.lastIndexOf(' ') + 1) < (verOffset = nAgt.lastIndexOf('/'))) {
                browserName = nAgt.substring(nameOffset, verOffset);
                fullVersion = nAgt.substring(verOffset + 1);

                if (browserName.toLowerCase() === browserName.toUpperCase()) {
                    browserName = navigator.appName;
                }
            }

            if (isEdge) {
                browserName = 'Edge';
                fullVersion = navigator.userAgent.split('Edge/')[1];
                // fullVersion = parseInt(navigator.userAgent.match(/Edge\/(\d+).(\d+)$/)[2], 10).toString();
            }

            // trim the fullVersion string at semicolon/space/bracket if present
            if ((ix = fullVersion.search(/[; \)]/)) !== -1) {
                fullVersion = fullVersion.substring(0, ix);
            }

            majorVersion = parseInt('' + fullVersion, 10);

            if (isNaN(majorVersion)) {
                fullVersion = '' + parseFloat(navigator.appVersion);
                majorVersion = parseInt(navigator.appVersion, 10);
            }

            return {
                fullVersion: fullVersion,
                version: majorVersion,
                name: browserName,
                isPrivateBrowsing: false
            };
        }

        // via: https://gist.github.com/cou929/7973956

        function retry(isDone, next) {
            var currentTrial = 0,
                maxRetry = 50,
                interval = 10,
                isTimeout = false;
            var id = window.setInterval(
                function() {
                    if (isDone()) {
                        window.clearInterval(id);
                        next(isTimeout);
                    }
                    if (currentTrial++ > maxRetry) {
                        window.clearInterval(id);
                        isTimeout = true;
                        next(isTimeout);
                    }
                },
                10
            );
        }

        function isIE10OrLater(userAgent) {
            var ua = userAgent.toLowerCase();
            if (ua.indexOf('msie') === 0 && ua.indexOf('trident') === 0) {
                return false;
            }
            var match = /(?:msie|rv:)\s?([\d\.]+)/.exec(ua);
            if (match && parseInt(match[1], 10) >= 10) {
                return true;
            }
            return false;
        }

        function detectPrivateMode(callback) {
            var isPrivate;

            try {

                if (window.webkitRequestFileSystem) {
                    window.webkitRequestFileSystem(
                        window.TEMPORARY, 1,
                        function() {
                            isPrivate = false;
                        },
                        function(e) {
                            isPrivate = true;
                        }
                    );
                } else if (window.indexedDB && /Firefox/.test(window.navigator.userAgent)) {
                    var db;
                    try {
                        db = window.indexedDB.open('test');
                        db.onerror = function() {
                            return true;
                        };
                    } catch (e) {
                        isPrivate = true;
                    }

                    if (typeof isPrivate === 'undefined') {
                        retry(
                            function isDone() {
                                return db.readyState === 'done' ? true : false;
                            },
                            function next(isTimeout) {
                                if (!isTimeout) {
                                    isPrivate = db.result ? false : true;
                                }
                            }
                        );
                    }
                } else if (isIE10OrLater(window.navigator.userAgent)) {
                    isPrivate = false;
                    try {
                        if (!window.indexedDB) {
                            isPrivate = true;
                        }
                    } catch (e) {
                        isPrivate = true;
                    }
                } else if (window.localStorage && /Safari/.test(window.navigator.userAgent)) {
                    try {
                        window.localStorage.setItem('test', 1);
                    } catch (e) {
                        isPrivate = true;
                    }

                    if (typeof isPrivate === 'undefined') {
                        isPrivate = false;
                        window.localStorage.removeItem('test');
                    }
                }

            } catch (e) {
                isPrivate = false;
            }

            retry(
                function isDone() {
                    return typeof isPrivate !== 'undefined' ? true : false;
                },
                function next(isTimeout) {
                    callback(isPrivate);
                }
            );
        }

        var isMobile = {
            Android: function() {
                return navigator.userAgent.match(/Android/i);
            },
            BlackBerry: function() {
                return navigator.userAgent.match(/BlackBerry|BB10/i);
            },
            iOS: function() {
                return navigator.userAgent.match(/iPhone|iPad|iPod/i);
            },
            Opera: function() {
                return navigator.userAgent.match(/Opera Mini/i);
            },
            Windows: function() {
                return navigator.userAgent.match(/IEMobile/i);
            },
            any: function() {
                return (isMobile.Android() || isMobile.BlackBerry() || isMobile.iOS() || isMobile.Opera() || isMobile.Windows());
            },
            getOsName: function() {
                var osName = 'Unknown OS';
                if (isMobile.Android()) {
                    osName = 'Android';
                }

                if (isMobile.BlackBerry()) {
                    osName = 'BlackBerry';
                }

                if (isMobile.iOS()) {
                    osName = 'iOS';
                }

                if (isMobile.Opera()) {
                    osName = 'Opera Mini';
                }

                if (isMobile.Windows()) {
                    osName = 'Windows';
                }

                return osName;
            }
        };

        // via: http://jsfiddle.net/ChristianL/AVyND/
        function detectDesktopOS() {
            var unknown = '-';

            var nVer = navigator.appVersion;
            var nAgt = navigator.userAgent;

            var os = unknown;
            var clientStrings = [{
                s: 'Windows 10',
                r: /(Windows 10.0|Windows NT 10.0)/
            }, {
                s: 'Windows 8.1',
                r: /(Windows 8.1|Windows NT 6.3)/
            }, {
                s: 'Windows 8',
                r: /(Windows 8|Windows NT 6.2)/
            }, {
                s: 'Windows 7',
                r: /(Windows 7|Windows NT 6.1)/
            }, {
                s: 'Windows Vista',
                r: /Windows NT 6.0/
            }, {
                s: 'Windows Server 2003',
                r: /Windows NT 5.2/
            }, {
                s: 'Windows XP',
                r: /(Windows NT 5.1|Windows XP)/
            }, {
                s: 'Windows 2000',
                r: /(Windows NT 5.0|Windows 2000)/
            }, {
                s: 'Windows ME',
                r: /(Win 9x 4.90|Windows ME)/
            }, {
                s: 'Windows 98',
                r: /(Windows 98|Win98)/
            }, {
                s: 'Windows 95',
                r: /(Windows 95|Win95|Windows_95)/
            }, {
                s: 'Windows NT 4.0',
                r: /(Windows NT 4.0|WinNT4.0|WinNT|Windows NT)/
            }, {
                s: 'Windows CE',
                r: /Windows CE/
            }, {
                s: 'Windows 3.11',
                r: /Win16/
            }, {
                s: 'Android',
                r: /Android/
            }, {
                s: 'Open BSD',
                r: /OpenBSD/
            }, {
                s: 'Sun OS',
                r: /SunOS/
            }, {
                s: 'Linux',
                r: /(Linux|X11)/
            }, {
                s: 'iOS',
                r: /(iPhone|iPad|iPod)/
            }, {
                s: 'Mac OS X',
                r: /Mac OS X/
            }, {
                s: 'Mac OS',
                r: /(MacPPC|MacIntel|Mac_PowerPC|Macintosh)/
            }, {
                s: 'QNX',
                r: /QNX/
            }, {
                s: 'UNIX',
                r: /UNIX/
            }, {
                s: 'BeOS',
                r: /BeOS/
            }, {
                s: 'OS/2',
                r: /OS\/2/
            }, {
                s: 'Search Bot',
                r: /(nuhk|Googlebot|Yammybot|Openbot|Slurp|MSNBot|Ask Jeeves\/Teoma|ia_archiver)/
            }];
            for (var i = 0, cs; cs = clientStrings[i]; i++) {
                if (cs.r.test(nAgt)) {
                    os = cs.s;
                    break;
                }
            }

            var osVersion = unknown;

            if (/Windows/.test(os)) {
                if (/Windows (.*)/.test(os)) {
                    osVersion = /Windows (.*)/.exec(os)[1];
                }
                os = 'Windows';
            }

            switch (os) {
                case 'Mac OS X':
                    if (/Mac OS X (10[\.\_\d]+)/.test(nAgt)) {
                        osVersion = /Mac OS X (10[\.\_\d]+)/.exec(nAgt)[1];
                    }
                    break;
                case 'Android':
                    if (/Android ([\.\_\d]+)/.test(nAgt)) {
                        osVersion = /Android ([\.\_\d]+)/.exec(nAgt)[1];
                    }
                    break;
                case 'iOS':
                    if (/OS (\d+)_(\d+)_?(\d+)?/.test(nAgt)) {
                        osVersion = /OS (\d+)_(\d+)_?(\d+)?/.exec(nVer);
                        osVersion = osVersion[1] + '.' + osVersion[2] + '.' + (osVersion[3] | 0);
                    }
                    break;
            }

            return {
                osName: os,
                osVersion: osVersion
            };
        }

        var osName = 'Unknown OS';
        var osVersion = 'Unknown OS Version';

        function getAndroidVersion(ua) {
            ua = (ua || navigator.userAgent).toLowerCase();
            var match = ua.match(/android\s([0-9\.]*)/);
            return match ? match[1] : false;
        }

        var osInfo = detectDesktopOS();

        if (osInfo && osInfo.osName && osInfo.osName != '-') {
            osName = osInfo.osName;
            osVersion = osInfo.osVersion;
        } else if (isMobile.any()) {
            osName = isMobile.getOsName();

            if (osName == 'Android') {
                osVersion = getAndroidVersion();
            }
        }

        var isNodejs = typeof process === 'object' && typeof process.versions === 'object' && process.versions.node;

        if (osName === 'Unknown OS' && isNodejs) {
            osName = 'Nodejs';
            osVersion = process.versions.node.toString().replace('v', '');
        }

        var isCanvasSupportsStreamCapturing = false;
        var isVideoSupportsStreamCapturing = false;
        ['captureStream', 'mozCaptureStream', 'webkitCaptureStream'].forEach(function(item) {
            if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
                return;
            }

            if (!isCanvasSupportsStreamCapturing && item in document.createElement('canvas')) {
                isCanvasSupportsStreamCapturing = true;
            }

            if (!isVideoSupportsStreamCapturing && item in document.createElement('video')) {
                isVideoSupportsStreamCapturing = true;
            }
        });

        // via: https://github.com/diafygi/webrtc-ips
        function DetectLocalIPAddress(callback) {
            if (!DetectRTC.isWebRTCSupported) {
                return;
            }

            if (DetectRTC.isORTCSupported) {
                return;
            }

            getIPs(function(ip) {
                //local IPs
                if (ip.match(/^(192\.168\.|169\.254\.|10\.|172\.(1[6-9]|2\d|3[01]))/)) {
                    callback('Local: ' + ip);
                }

                //assume the rest are public IPs
                else {
                    callback('Public: ' + ip);
                }
            });
        }

        //get the IP addresses associated with an account
        function getIPs(callback) {
            if (typeof document === 'undefined' || typeof document.getElementById !== 'function') {
                return;
            }

            var ipDuplicates = {};

            //compatibility for firefox and chrome
            var RTCPeerConnection = window.RTCPeerConnection || window.mozRTCPeerConnection || window.webkitRTCPeerConnection;
            var useWebKit = !!window.webkitRTCPeerConnection;

            // bypass naive webrtc blocking using an iframe
            if (!RTCPeerConnection) {
                var iframe = document.getElementById('iframe');
                if (!iframe) {
                    //<iframe id="iframe" sandbox="allow-same-origin" style="display: none"></iframe>
                    throw 'NOTE: you need to have an iframe in the page right above the script tag.';
                }
                var win = iframe.contentWindow;
                RTCPeerConnection = win.RTCPeerConnection || win.mozRTCPeerConnection || win.webkitRTCPeerConnection;
                useWebKit = !!win.webkitRTCPeerConnection;
            }

            // if still no RTCPeerConnection then it is not supported by the browser so just return
            if (!RTCPeerConnection) {
                return;
            }

            //minimal requirements for data connection
            var mediaConstraints = {
                optional: [{
                    RtpDataChannels: true
                }]
            };

            //firefox already has a default stun server in about:config
            //    media.peerconnection.default_iceservers =
            //    [{"url": "stun:stun.services.mozilla.com"}]
            var servers;

            //add same stun server for chrome
            if (useWebKit) {
                servers = {
                    iceServers: [{
                        urls: 'stun:stun.services.mozilla.com'
                    }]
                };

                if (typeof DetectRTC !== 'undefined' && DetectRTC.browser.isFirefox && DetectRTC.browser.version <= 38) {
                    servers[0] = {
                        url: servers[0].urls
                    };
                }
            }

            //construct a new RTCPeerConnection
            var pc = new RTCPeerConnection(servers, mediaConstraints);

            function handleCandidate(candidate) {
                //match just the IP address
                var ipRegex = /([0-9]{1,3}(\.[0-9]{1,3}){3})/;
                var match = ipRegex.exec(candidate);
                if (!match) {
                    console.warn('Could not match IP address in', candidate);
                    return;
                }
                var ipAddress = match[1];

                //remove duplicates
                if (ipDuplicates[ipAddress] === undefined) {
                    callback(ipAddress);
                }

                ipDuplicates[ipAddress] = true;
            }

            //listen for candidate events
            pc.onicecandidate = function(ice) {
                //skip non-candidate events
                if (ice.candidate) {
                    handleCandidate(ice.candidate.candidate);
                }
            };

            //create a bogus data channel
            pc.createDataChannel('');

            //create an offer sdp
            pc.createOffer(function(result) {

                //trigger the stun server request
                pc.setLocalDescription(result, function() {}, function() {});

            }, function() {});

            //wait for a while to let everything done
            setTimeout(function() {
                //read candidate info from local description
                var lines = pc.localDescription.sdp.split('\n');

                lines.forEach(function(line) {
                    if (line.indexOf('a=candidate:') === 0) {
                        handleCandidate(line);
                    }
                });
            }, 1000);
        }

        var MediaDevices = [];

        var audioInputDevices = [];
        var audioOutputDevices = [];
        var videoInputDevices = [];

        if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
            // Firefox 38+ seems having support of enumerateDevices
            // Thanks @xdumaine/enumerateDevices
            navigator.enumerateDevices = function(callback) {
                navigator.mediaDevices.enumerateDevices().then(callback).catch(function() {
                    callback([]);
                });
            };
        }

        // Media Devices detection
        var canEnumerate = false;

        /*global MediaStreamTrack:true */
        if (typeof MediaStreamTrack !== 'undefined' && 'getSources' in MediaStreamTrack) {
            canEnumerate = true;
        } else if (navigator.mediaDevices && !!navigator.mediaDevices.enumerateDevices) {
            canEnumerate = true;
        }

        var hasMicrophone = false;
        var hasSpeakers = false;
        var hasWebcam = false;

        var isWebsiteHasMicrophonePermissions = false;
        var isWebsiteHasWebcamPermissions = false;

        // http://dev.w3.org/2011/webrtc/editor/getusermedia.html#mediadevices
        function checkDeviceSupport(callback) {
            if (!canEnumerate) {
                if (callback) {
                    callback();
                }
                return;
            }

            if (!navigator.enumerateDevices && window.MediaStreamTrack && window.MediaStreamTrack.getSources) {
                navigator.enumerateDevices = window.MediaStreamTrack.getSources.bind(window.MediaStreamTrack);
            }

            if (!navigator.enumerateDevices && navigator.enumerateDevices) {
                navigator.enumerateDevices = navigator.enumerateDevices.bind(navigator);
            }

            if (!navigator.enumerateDevices) {
                if (callback) {
                    callback();
                }
                return;
            }

            MediaDevices = [];

            audioInputDevices = [];
            audioOutputDevices = [];
            videoInputDevices = [];

            hasMicrophone = false;
            hasSpeakers = false;
            hasWebcam = false;

            isWebsiteHasMicrophonePermissions = false;
            isWebsiteHasWebcamPermissions = false;

            // to prevent duplication
            var alreadyUsedDevices = {};

            navigator.enumerateDevices(function(devices) {
                devices.forEach(function(_device) {
                    var device = {};
                    for (var d in _device) {
                        try {
                            if (typeof _device[d] !== 'function') {
                                device[d] = _device[d];
                            }
                        } catch (e) {}
                    }

                    if (alreadyUsedDevices[device.deviceId + device.label]) {
                        return;
                    }

                    // if it is MediaStreamTrack.getSources
                    if (device.kind === 'audio') {
                        device.kind = 'audioinput';
                    }

                    if (device.kind === 'video') {
                        device.kind = 'videoinput';
                    }

                    if (!device.deviceId) {
                        device.deviceId = device.id;
                    }

                    if (!device.id) {
                        device.id = device.deviceId;
                    }

                    if (!device.label) {
                        device.label = 'Please invoke getUserMedia once.';
                        if (typeof DetectRTC !== 'undefined' && DetectRTC.browser.isChrome && DetectRTC.browser.version >= 46 && !/^(https:|chrome-extension:)$/g.test(location.protocol || '')) {
                            if (typeof document !== 'undefined' && typeof document.domain === 'string' && document.domain.search && document.domain.search(/localhost|127.0./g) === -1) {
                                device.label = 'HTTPs is required to get label of this ' + device.kind + ' device.';
                            }
                        }
                    } else {
                        if (device.kind === 'videoinput' && !isWebsiteHasWebcamPermissions) {
                            isWebsiteHasWebcamPermissions = true;
                        }

                        if (device.kind === 'audioinput' && !isWebsiteHasMicrophonePermissions) {
                            isWebsiteHasMicrophonePermissions = true;
                        }
                    }

                    if (device.kind === 'audioinput') {
                        hasMicrophone = true;

                        if (audioInputDevices.indexOf(device) === -1) {
                            audioInputDevices.push(device);
                        }
                    }

                    if (device.kind === 'audiooutput') {
                        hasSpeakers = true;

                        if (audioOutputDevices.indexOf(device) === -1) {
                            audioOutputDevices.push(device);
                        }
                    }

                    if (device.kind === 'videoinput') {
                        hasWebcam = true;

                        if (videoInputDevices.indexOf(device) === -1) {
                            videoInputDevices.push(device);
                        }
                    }

                    // there is no 'videoouput' in the spec.
                    MediaDevices.push(device);

                    alreadyUsedDevices[device.deviceId + device.label] = device;
                });

                if (typeof DetectRTC !== 'undefined') {
                    // to sync latest outputs
                    DetectRTC.MediaDevices = MediaDevices;
                    DetectRTC.hasMicrophone = hasMicrophone;
                    DetectRTC.hasSpeakers = hasSpeakers;
                    DetectRTC.hasWebcam = hasWebcam;

                    DetectRTC.isWebsiteHasWebcamPermissions = isWebsiteHasWebcamPermissions;
                    DetectRTC.isWebsiteHasMicrophonePermissions = isWebsiteHasMicrophonePermissions;

                    DetectRTC.audioInputDevices = audioInputDevices;
                    DetectRTC.audioOutputDevices = audioOutputDevices;
                    DetectRTC.videoInputDevices = videoInputDevices;
                }

                if (callback) {
                    callback();
                }
            });
        }

        var DetectRTC = window.DetectRTC || {};

        // ----------
        // DetectRTC.browser.name || DetectRTC.browser.version || DetectRTC.browser.fullVersion
        DetectRTC.browser = getBrowserInfo();

        detectPrivateMode(function(isPrivateBrowsing) {
            DetectRTC.browser.isPrivateBrowsing = !!isPrivateBrowsing;
        });

        // DetectRTC.isChrome || DetectRTC.isFirefox || DetectRTC.isEdge
        DetectRTC.browser['is' + DetectRTC.browser.name] = true;

        // -----------
        DetectRTC.osName = osName;
        DetectRTC.osVersion = osVersion;

        var isNodeWebkit = typeof process === 'object' && typeof process.versions === 'object' && process.versions['node-webkit'];

        // --------- Detect if system supports WebRTC 1.0 or WebRTC 1.1.
        var isWebRTCSupported = false;
        ['RTCPeerConnection', 'webkitRTCPeerConnection', 'mozRTCPeerConnection', 'RTCIceGatherer'].forEach(function(item) {
            if (isWebRTCSupported) {
                return;
            }

            if (item in window) {
                isWebRTCSupported = true;
            }
        });
        DetectRTC.isWebRTCSupported = isWebRTCSupported;

        //-------
        DetectRTC.isORTCSupported = typeof RTCIceGatherer !== 'undefined';

        // --------- Detect if system supports screen capturing API
        var isScreenCapturingSupported = false;
        if (DetectRTC.browser.isChrome && DetectRTC.browser.version >= 35) {
            isScreenCapturingSupported = true;
        } else if (DetectRTC.browser.isFirefox && DetectRTC.browser.version >= 34) {
            isScreenCapturingSupported = true;
        }

        if (!/^(https:|chrome-extension:)$/g.test(location.protocol || '')) {
            if (typeof document !== 'undefined' && typeof document.domain === 'string' && document.domain.search && document.domain.search(/localhost|127.0./g) === -1) {
                // DetectRTC.browser.isChrome
                isScreenCapturingSupported = false;
            }

            if (DetectRTC.browser.isFirefox) {
                isScreenCapturingSupported = false;
            }
        }
        DetectRTC.isScreenCapturingSupported = isScreenCapturingSupported;

        // --------- Detect if WebAudio API are supported
        var webAudio = {
            isSupported: false,
            isCreateMediaStreamSourceSupported: false
        };

        ['AudioContext', 'webkitAudioContext', 'mozAudioContext', 'msAudioContext'].forEach(function(item) {
            if (webAudio.isSupported) {
                return;
            }

            if (item in window) {
                webAudio.isSupported = true;

                if (window[item] && 'createMediaStreamSource' in window[item].prototype) {
                    webAudio.isCreateMediaStreamSourceSupported = true;
                }
            }
        });
        DetectRTC.isAudioContextSupported = webAudio.isSupported;
        DetectRTC.isCreateMediaStreamSourceSupported = webAudio.isCreateMediaStreamSourceSupported;

        // ---------- Detect if SCTP/RTP channels are supported.

        var isRtpDataChannelsSupported = false;
        if (DetectRTC.browser.isChrome && DetectRTC.browser.version > 31) {
            isRtpDataChannelsSupported = true;
        }
        DetectRTC.isRtpDataChannelsSupported = isRtpDataChannelsSupported;

        var isSCTPSupportd = false;
        if (DetectRTC.browser.isFirefox && DetectRTC.browser.version > 28) {
            isSCTPSupportd = true;
        } else if (DetectRTC.browser.isChrome && DetectRTC.browser.version > 25) {
            isSCTPSupportd = true;
        } else if (DetectRTC.browser.isOpera && DetectRTC.browser.version >= 11) {
            isSCTPSupportd = true;
        }
        DetectRTC.isSctpDataChannelsSupported = isSCTPSupportd;

        // ---------

        DetectRTC.isMobileDevice = isMobileDevice; // "isMobileDevice" boolean is defined in "getBrowserInfo.js"

        // ------
        var isGetUserMediaSupported = false;
        if (navigator.getUserMedia) {
            isGetUserMediaSupported = true;
        } else if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
            isGetUserMediaSupported = true;
        }

        if (DetectRTC.browser.isChrome && DetectRTC.browser.version >= 46 && !/^(https:|chrome-extension:)$/g.test(location.protocol || '')) {
            if (typeof document !== 'undefined' && typeof document.domain === 'string' && document.domain.search && document.domain.search(/localhost|127.0./g) === -1) {
                isGetUserMediaSupported = 'Requires HTTPs';
            }
        }

        if (DetectRTC.osName === 'Nodejs') {
            isGetUserMediaSupported = false;
        }
        DetectRTC.isGetUserMediaSupported = isGetUserMediaSupported;

        var displayResolution = '';
        if (screen.width) {
            var width = (screen.width) ? screen.width : '';
            var height = (screen.height) ? screen.height : '';
            displayResolution += '' + width + ' x ' + height;
        }
        DetectRTC.displayResolution = displayResolution;

        function getAspectRatio(w, h) {
            function gcd(a, b) {
                return (b == 0) ? a : gcd(b, a % b);
            }
            var r = gcd(w, h);
            return (w / r) / (h / r);
        }

        DetectRTC.displayAspectRatio = getAspectRatio(screen.width, screen.height).toFixed(2);

        // ----------
        DetectRTC.isCanvasSupportsStreamCapturing = isCanvasSupportsStreamCapturing;
        DetectRTC.isVideoSupportsStreamCapturing = isVideoSupportsStreamCapturing;

        if (DetectRTC.browser.name == 'Chrome' && DetectRTC.browser.version >= 53) {
            if (!DetectRTC.isCanvasSupportsStreamCapturing) {
                DetectRTC.isCanvasSupportsStreamCapturing = 'Requires chrome flag: enable-experimental-web-platform-features';
            }

            if (!DetectRTC.isVideoSupportsStreamCapturing) {
                DetectRTC.isVideoSupportsStreamCapturing = 'Requires chrome flag: enable-experimental-web-platform-features';
            }
        }

        // ------
        DetectRTC.DetectLocalIPAddress = DetectLocalIPAddress;

        DetectRTC.isWebSocketsSupported = 'WebSocket' in window && 2 === window.WebSocket.CLOSING;
        DetectRTC.isWebSocketsBlocked = !DetectRTC.isWebSocketsSupported;

        if (DetectRTC.osName === 'Nodejs') {
            DetectRTC.isWebSocketsSupported = true;
            DetectRTC.isWebSocketsBlocked = false;
        }

        DetectRTC.checkWebSocketsSupport = function(callback) {
            callback = callback || function() {};
            try {
                var websocket = new WebSocket('wss://echo.websocket.org:443/');
                websocket.onopen = function() {
                    DetectRTC.isWebSocketsBlocked = false;
                    callback();
                    websocket.close();
                    websocket = null;
                };
                websocket.onerror = function() {
                    DetectRTC.isWebSocketsBlocked = true;
                    callback();
                };
            } catch (e) {
                DetectRTC.isWebSocketsBlocked = true;
                callback();
            }
        };

        // -------
        DetectRTC.load = function(callback) {
            callback = callback || function() {};
            checkDeviceSupport(callback);
        };

        // check for microphone/camera support!
        if (typeof checkDeviceSupport === 'function') {
            // checkDeviceSupport();
        }

        if (typeof MediaDevices !== 'undefined') {
            DetectRTC.MediaDevices = MediaDevices;
        } else {
            DetectRTC.MediaDevices = [];
        }

        DetectRTC.hasMicrophone = hasMicrophone;
        DetectRTC.hasSpeakers = hasSpeakers;
        DetectRTC.hasWebcam = hasWebcam;

        DetectRTC.isWebsiteHasWebcamPermissions = isWebsiteHasWebcamPermissions;
        DetectRTC.isWebsiteHasMicrophonePermissions = isWebsiteHasMicrophonePermissions;

        DetectRTC.audioInputDevices = audioInputDevices;
        DetectRTC.audioOutputDevices = audioOutputDevices;
        DetectRTC.videoInputDevices = videoInputDevices;

        // ------
        var isSetSinkIdSupported = false;
        if (typeof document !== 'undefined' && typeof document.createElement === 'function' && 'setSinkId' in document.createElement('video')) {
            isSetSinkIdSupported = true;
        }
        DetectRTC.isSetSinkIdSupported = isSetSinkIdSupported;

        // -----
        var isRTPSenderReplaceTracksSupported = false;
        if (DetectRTC.browser.isFirefox && typeof mozRTCPeerConnection !== 'undefined' /*&& DetectRTC.browser.version > 39*/ ) {
            /*global mozRTCPeerConnection:true */
            if ('getSenders' in mozRTCPeerConnection.prototype) {
                isRTPSenderReplaceTracksSupported = true;
            }
        } else if (DetectRTC.browser.isChrome && typeof webkitRTCPeerConnection !== 'undefined') {
            /*global webkitRTCPeerConnection:true */
            if ('getSenders' in webkitRTCPeerConnection.prototype) {
                isRTPSenderReplaceTracksSupported = true;
            }
        }
        DetectRTC.isRTPSenderReplaceTracksSupported = isRTPSenderReplaceTracksSupported;

        //------
        var isRemoteStreamProcessingSupported = false;
        if (DetectRTC.browser.isFirefox && DetectRTC.browser.version > 38) {
            isRemoteStreamProcessingSupported = true;
        }
        DetectRTC.isRemoteStreamProcessingSupported = isRemoteStreamProcessingSupported;

        //-------
        var isApplyConstraintsSupported = false;

        /*global MediaStreamTrack:true */
        if (typeof MediaStreamTrack !== 'undefined' && 'applyConstraints' in MediaStreamTrack.prototype) {
            isApplyConstraintsSupported = true;
        }
        DetectRTC.isApplyConstraintsSupported = isApplyConstraintsSupported;

        //-------
        var isMultiMonitorScreenCapturingSupported = false;
        if (DetectRTC.browser.isFirefox && DetectRTC.browser.version >= 43) {
            // version 43 merely supports platforms for multi-monitors
            // version 44 will support exact multi-monitor selection i.e. you can select any monitor for screen capturing.
            isMultiMonitorScreenCapturingSupported = true;
        }
        DetectRTC.isMultiMonitorScreenCapturingSupported = isMultiMonitorScreenCapturingSupported;

        DetectRTC.isPromisesSupported = !!('Promise' in window);

        if (typeof DetectRTC === 'undefined') {
            window.DetectRTC = {};
        }

        var MediaStream = window.MediaStream;

        if (typeof MediaStream === 'undefined' && typeof webkitMediaStream !== 'undefined') {
            MediaStream = webkitMediaStream;
        }

        if (typeof MediaStream !== 'undefined') {
            DetectRTC.MediaStream = Object.keys(MediaStream.prototype);
        } else DetectRTC.MediaStream = false;

        if (typeof MediaStreamTrack !== 'undefined') {
            DetectRTC.MediaStreamTrack = Object.keys(MediaStreamTrack.prototype);
        } else DetectRTC.MediaStreamTrack = false;

        var RTCPeerConnection = window.RTCPeerConnection || window.mozRTCPeerConnection || window.webkitRTCPeerConnection;

        if (typeof RTCPeerConnection !== 'undefined') {
            DetectRTC.RTCPeerConnection = Object.keys(RTCPeerConnection.prototype);
        } else DetectRTC.RTCPeerConnection = false;

        window.DetectRTC = DetectRTC;

        if (typeof module !== 'undefined' /* && !!module.exports*/ ) {
            module.exports = DetectRTC;
        }

        if (typeof define === 'function' && define.amd) {
            define('DetectRTC', [], function() {
                return DetectRTC;
            });
        }
    })();

    // globals.js

    if (typeof cordova !== 'undefined') {
        DetectRTC.isMobileDevice = true;
        DetectRTC.browser.name = 'Chrome';
    }

    if (navigator && navigator.userAgent && navigator.userAgent.indexOf('Crosswalk') !== -1) {
        DetectRTC.isMobileDevice = true;
        DetectRTC.browser.name = 'Chrome';
    }

    function fireEvent(obj, eventName, args) {
        var eventDetail = {
            arguments: args,
            __exposedProps__: args
        };
    }

    function setHarkEvents(connection, streamEvent) {
        if (!connection || !streamEvent) {
            throw 'Both arguments are required.';
        }

        if (!connection.onspeaking || !connection.onsilence) {
            return;
        }

        if (typeof hark === 'undefined') {
            throw 'hark.js not found.';
        }

        hark(streamEvent.stream, {
            onspeaking: function() {
                connection.onspeaking(streamEvent);
            },
            onsilence: function() {
                connection.onsilence(streamEvent);
            },
            onvolumechange: function(volume, threshold) {
                if (!connection.onvolumechange) {
                    return;
                }
                connection.onvolumechange(merge({
                    volume: volume,
                    threshold: threshold
                }, streamEvent));
            }
        });
    }

    function setMuteHandlers(connection, streamEvent) {
        if (!streamEvent.stream || !streamEvent.stream || !streamEvent.stream.addEventListener) return;

        streamEvent.stream.addEventListener('mute', function(event) {
            event = connection.streamEvents[streamEvent.streamid];

            event.session = {
                audio: event.muteType === 'audio',
                video: event.muteType === 'video'
            };

            connection.onmute(event);
        }, false);

        streamEvent.stream.addEventListener('unmute', function(event) {
            event = connection.streamEvents[streamEvent.streamid];

            event.session = {
                audio: event.unmuteType === 'audio',
                video: event.unmuteType === 'video'
            };

            connection.onunmute(event);
        }, false);
    }

    function getRandomString() {
        if (window.crypto && window.crypto.getRandomValues && navigator.userAgent.indexOf('Safari') === -1) {
            var a = window.crypto.getRandomValues(new Uint32Array(3)),
                token = '';
            for (var i = 0, l = a.length; i < l; i++) {
                token += a[i].toString(36);
            }
            return token;
        } else {
            return (Math.random() * new Date().getTime()).toString(36).replace(/\./g, '');
        }
    }

    // Get HTMLAudioElement/HTMLVideoElement accordingly

    function getRMCMediaElement(stream, callback, connection) {
        var isAudioOnly = false;
        if (!!stream.getVideoTracks && !stream.getVideoTracks().length && !stream.isVideo && !stream.isScreen) {
            isAudioOnly = true;
        }

        if (DetectRTC.browser.name === 'Firefox') {
            if (connection.session.video || connection.session.screen) {
                isAudioOnly = false;
            }
        }

        var mediaElement = document.createElement(isAudioOnly ? 'audio' : 'video');

        mediaElement.srcObject = stream;
        mediaElement.controls = true;

        // http://goo.gl/WZ5nFl
        // Firefox don't yet support onended for any stream (remote/local)
        if (DetectRTC.browser.name === 'Firefox') {
            var streamEndedEvent = 'ended';

            if ('oninactive' in mediaElement) {
                streamEndedEvent = 'inactive';
            }

            mediaElement.addEventListener(streamEndedEvent, function() {
                // fireEvent(stream, streamEndedEvent, stream);
                currentUserMediaRequest.remove(stream.idInstance);

                if (stream.type === 'local') {
                    streamEndedEvent = 'ended';

                    if ('oninactive' in stream) {
                        streamEndedEvent = 'inactive';
                    }

                    StreamsHandler.onSyncNeeded(stream.streamid, streamEndedEvent);

                    connection.attachStreams.forEach(function(aStream, idx) {
                        if (stream.streamid === aStream.streamid) {
                            delete connection.attachStreams[idx];
                        }
                    });

                    var newStreamsArray = [];
                    connection.attachStreams.forEach(function(aStream) {
                        if (aStream) {
                            newStreamsArray.push(aStream);
                        }
                    });
                    connection.attachStreams = newStreamsArray;

                    var streamEvent = connection.streamEvents[stream.streamid];

                    if (streamEvent) {
                        connection.onstreamended(streamEvent);
                        return;
                    }
                    if (this.parentNode) {
                        this.parentNode.removeChild(this);
                    }
                }
            }, false);
        }

        var played = mediaElement.play();
        if (typeof played !== 'undefined') {
            var cbFired = false;
            setTimeout(function() {
                if (!cbFired) {
                    cbFired = true;
                    callback(mediaElement);
                }
            }, 1000);
            played.then(function() {
                if (cbFired) return;
                cbFired = true;
                callback(mediaElement);
            }).catch(function(error) {
                if (cbFired) return;
                cbFired = true;
                callback(mediaElement);
            });
        } else {
            callback(mediaElement);
        }
    }

    // if IE
    if (!window.addEventListener) {
        window.addEventListener = function(el, eventName, eventHandler) {
            if (!el.attachEvent) {
                return;
            }
            el.attachEvent('on' + eventName, eventHandler);
        };
    }

    function listenEventHandler(eventName, eventHandler) {
        window.removeEventListener(eventName, eventHandler);
        window.addEventListener(eventName, eventHandler, false);
    }

    window.attachEventListener = function(video, type, listener, useCapture) {
        video.addEventListener(type, listener, useCapture);
    };

    function removeNullEntries(array) {
        var newArray = [];
        array.forEach(function(item) {
            if (item) {
                newArray.push(item);
            }
        });
        return newArray;
    }


    function isData(session) {
        return !session.audio && !session.video && !session.screen && session.data;
    }

    function isNull(obj) {
        return typeof obj === 'undefined';
    }

    function isString(obj) {
        return typeof obj === 'string';
    }

    var MediaStream = window.MediaStream;

    if (typeof MediaStream === 'undefined' && typeof webkitMediaStream !== 'undefined') {
        MediaStream = webkitMediaStream;
    }

    /*global MediaStream:true */
    if (typeof MediaStream !== 'undefined') {
        if (!('getVideoTracks' in MediaStream.prototype) || DetectRTC.browser.name === 'Firefox') {
            MediaStream.prototype.getVideoTracks = function() {
                if (!this.getTracks) {
                    return [];
                }

                var tracks = [];
                this.getTracks().forEach(function(track) {
                    if (track.kind.toString().indexOf('video') !== -1) {
                        tracks.push(track);
                    }
                });
                return tracks;
            };

            MediaStream.prototype.getAudioTracks = function() {
                if (!this.getTracks) {
                    return [];
                }

                var tracks = [];
                this.getTracks().forEach(function(track) {
                    if (track.kind.toString().indexOf('audio') !== -1) {
                        tracks.push(track);
                    }
                });
                return tracks;
            };
        }

        if (!('stop' in MediaStream.prototype) || DetectRTC.browser.name === 'Firefox') {
            MediaStream.prototype.stop = function() {
                this.getAudioTracks().forEach(function(track) {
                    if (!!track.stop) {
                        track.stop();
                    }
                });

                this.getVideoTracks().forEach(function(track) {
                    if (!!track.stop) {
                        track.stop();
                    }
                });
            };
        }
    }

    function isAudioPlusTab(connection, audioPlusTab) {
        if (connection.session.audio && connection.session.audio === 'two-way') {
            return false;
        }

        if (DetectRTC.browser.name === 'Firefox' && audioPlusTab !== false) {
            return true;
        }

        if (DetectRTC.browser.name !== 'Chrome' || DetectRTC.browser.version < 50) return false;

        if (typeof audioPlusTab === true) {
            return true;
        }

        if (typeof audioPlusTab === 'undefined' && connection.session.audio && connection.session.screen && !connection.session.video) {
            audioPlusTab = true;
            return true;
        }

        return false;
    }

    function getAudioScreenConstraints(screen_constraints) {
        if (DetectRTC.browser.name === 'Firefox') {
            return true;
        }

        if (DetectRTC.browser.name !== 'Chrome') return false;

        return {
            mandatory: {
                chromeMediaSource: screen_constraints.mandatory.chromeMediaSource,
                chromeMediaSourceId: screen_constraints.mandatory.chromeMediaSourceId
            }
        };
    }

    window.iOSDefaultAudioOutputDevice = window.iOSDefaultAudioOutputDevice || 'speaker'; // earpiece or speaker

    if (typeof window.enableAdapter === 'undefined') {
        if (DetectRTC.browser.name === 'Firefox' && DetectRTC.browser.version >= 54) {
            window.enableAdapter = true;
        }

        if (DetectRTC.browser.name === 'Chrome' && DetectRTC.browser.version >= 60) {
            // window.enableAdapter = true;
        }

        if (typeof adapter !== 'undefined' && adapter.browserDetails && typeof adapter.browserDetails.browser === 'string') {
            window.enableAdapter = true;
        }
    }

    if (!window.enableAdapter) {
        if (typeof URL.createObjectURL === 'undefined') {
            URL.createObjectURL = function(stream) {
                return 'blob:https://' + document.domain + '/' + getRandomString();
            };
        }

        if (!('srcObject' in HTMLMediaElement.prototype)) {
            HTMLMediaElement.prototype.srcObject = function(stream) {
                if ('mozSrcObject' in this) {
                    this.mozSrcObject = stream;
                    return;
                }

                this.src = URL.createObjectURL(stream);
            };
        }

        // need RTCPeerConnection shim here
    }

    // ios-hacks.js

    function setCordovaAPIs() {
        // if (DetectRTC.osName !== 'iOS') return;
        if (typeof cordova === 'undefined' || typeof cordova.plugins === 'undefined' || typeof cordova.plugins.iosrtc === 'undefined') return;

        var iosrtc = cordova.plugins.iosrtc;
        window.webkitRTCPeerConnection = iosrtc.RTCPeerConnection;
        window.RTCSessionDescription = iosrtc.RTCSessionDescription;
        window.RTCIceCandidate = iosrtc.RTCIceCandidate;
        window.MediaStream = iosrtc.MediaStream;
        window.MediaStreamTrack = iosrtc.MediaStreamTrack;
        navigator.getUserMedia = navigator.webkitGetUserMedia = iosrtc.getUserMedia;

        iosrtc.debug.enable('iosrtc*');
        if (typeof iosrtc.selectAudioOutput == 'function') {
            iosrtc.selectAudioOutput(window.iOSDefaultAudioOutputDevice || 'speaker'); // earpiece or speaker
        }
        iosrtc.registerGlobals();
    }

    document.addEventListener('deviceready', setCordovaAPIs, false);
    setCordovaAPIs();


    // RTCPeerConnection.js 기본 동작 부분
    var defaults = {};

    function setSdpConstraints(config) {
        var sdpConstraints = {
            OfferToReceiveAudio: !!config.OfferToReceiveAudio,
            OfferToReceiveVideo: !!config.OfferToReceiveVideo
        };

        var oldBrowser = !window.enableAdapter;

        if (DetectRTC.browser.name === 'Chrome' && DetectRTC.browser.version >= 60) {
            // oldBrowser = false;
        }

        if (DetectRTC.browser.name === 'Firefox' && DetectRTC.browser.version >= 54) {
            oldBrowser = false;
        }

        if (oldBrowser) {
            sdpConstraints = {
                mandatory: sdpConstraints,
                optional: [{
                    VoiceActivityDetection: false
                }]
            };
        }

        return sdpConstraints;
    }

    var RTCPeerConnection;
    if (typeof window.RTCPeerConnection !== 'undefined') {
        RTCPeerConnection = window.RTCPeerConnection;
    } else if (typeof mozRTCPeerConnection !== 'undefined') {
        RTCPeerConnection = mozRTCPeerConnection;
    } else if (typeof webkitRTCPeerConnection !== 'undefined') {
        RTCPeerConnection = webkitRTCPeerConnection;
    }

    var RTCSessionDescription = window.RTCSessionDescription || window.mozRTCSessionDescription;
    var RTCIceCandidate = window.RTCIceCandidate || window.mozRTCIceCandidate;
    var MediaStreamTrack = window.MediaStreamTrack;

    function PeerInitiator(config) {
        if (typeof window.RTCPeerConnection !== 'undefined') {
            RTCPeerConnection = window.RTCPeerConnection;
        } else if (typeof mozRTCPeerConnection !== 'undefined') {
            RTCPeerConnection = mozRTCPeerConnection;
        } else if (typeof webkitRTCPeerConnection !== 'undefined') {
            RTCPeerConnection = webkitRTCPeerConnection;
        }

        RTCSessionDescription = window.RTCSessionDescription || window.mozRTCSessionDescription;
        RTCIceCandidate = window.RTCIceCandidate || window.mozRTCIceCandidate;
        MediaStreamTrack = window.MediaStreamTrack;

        if (!RTCPeerConnection) {
            throw 'WebRTC 1.0 (RTCPeerConnection) API are NOT available in this browser.';
        }

        var connection = config.rtcMultiConnection;

        this.extra = config.remoteSdp ? config.remoteSdp.extra : connection.extra;
        this.userid = config.userid;
        this.streams = [];
        this.channels = config.channels || [];
        this.connectionDescription = config.connectionDescription;

        this.addStream = function(session) {
            connection.addStream(session, self.userid);
        };

        this.removeStream = function(streamid) {
            connection.removeStream(streamid, self.userid);
        };

        var self = this;

        if (config.remoteSdp) {
            this.connectionDescription = config.remoteSdp.connectionDescription;
        }

        var allRemoteStreams = {};

        defaults.sdpConstraints = setSdpConstraints({
            OfferToReceiveAudio: true,
            OfferToReceiveVideo: true
        });

        var peer;

        var renegotiatingPeer = !!config.renegotiatingPeer;
        if (config.remoteSdp) {
            renegotiatingPeer = !!config.remoteSdp.renegotiatingPeer;
        }

        var localStreams = [];
        connection.attachStreams.forEach(function(stream) {
            if (!!stream) {
                localStreams.push(stream);
            }
        });

        if (!renegotiatingPeer) {
            var iceTransports = 'all';
            if (connection.candidates.turn || connection.candidates.relay) {
                if (!connection.candidates.stun && !connection.candidates.reflexive && !connection.candidates.host) {
                    iceTransports = 'relay';
                }
            }

            try {
                var params = {};

                if (DetectRTC.browser.name !== 'Chrome') {
                    params.iceServers = connection.iceServers;
                }

                if (DetectRTC.browser.name === 'Chrome') {
                    params = {
                        iceServers: connection.iceServers,
                        iceTransportPolicy: connection.iceTransportPolicy || iceTransports,
                        // rtcpMuxPolicy: connection.rtcpMuxPolicy || 'require', // or negotiate
                        bundlePolicy: 'max-bundle',
                        iceCandidatePoolSize: connection.iceCandidatePoolSize || 0
                    };
                }

                if (!connection.iceServers.length) {
                    params = null;
                    connection.optionalArgument = null;
                }

                peer = new RTCPeerConnection(params, connection.optionalArgument);
            } catch (e) {
                try {
                    var params = {
                        iceServers: connection.iceServers
                    };

                    peer = new RTCPeerConnection(params);
                } catch (e) {
                    peer = new RTCPeerConnection();
                }
            }
        } else {
            peer = config.peerRef;
        }

        function getLocalStreams() {
            // if-block is temporarily disabled
            if (typeof window.InstallTrigger !== 'undefined' && 'getSenders' in peer && typeof peer.getSenders === 'function') {
                var streamObject2 = new MediaStream();
                peer.getSenders().forEach(function(sender) {
                    streamObject2.addTrack(sender.track);
                });
                return streamObject2;
            }

            return peer.getLocalStreams();
        }

        peer.onicecandidate = function(event) {
            if (!event.candidate) {
                if (!connection.trickleIce) {
                    var localSdp = peer.localDescription;
                    config.onLocalSdp({
                        type: localSdp.type,
                        sdp: localSdp.sdp,
                        remotePeerSdpConstraints: config.remotePeerSdpConstraints || false,
                        renegotiatingPeer: !!config.renegotiatingPeer || false,
                        connectionDescription: self.connectionDescription,
                        dontGetRemoteStream: !!config.dontGetRemoteStream,
                        extra: connection ? connection.extra : {},
                        streamsToShare: streamsToShare
                    });
                }
                return;
            }

            if (!connection.trickleIce) return;
            config.onLocalCandidate({
                candidate: event.candidate.candidate,
                sdpMid: event.candidate.sdpMid,
                sdpMLineIndex: event.candidate.sdpMLineIndex
            });
        };

        localStreams.forEach(function(localStream) {
            if (config.remoteSdp && config.remoteSdp.remotePeerSdpConstraints && config.remoteSdp.remotePeerSdpConstraints.dontGetRemoteStream) {
                return;
            }

            if (config.dontAttachLocalStream) {
                return;
            }

            localStream = connection.beforeAddingStream(localStream, self);

            if (!localStream) return;

            if (getLocalStreams().forEach) {
                getLocalStreams().forEach(function(stream) {
                    if (localStream && stream.id == localStream.id) {
                        localStream = null;
                    }
                });
            }

            if (localStream && typeof peer.addTrack === 'function') {
                localStream.getTracks().forEach(function(track) {
                    peer.addTrack(track, localStream);
                });
            } else if (localStream && typeof peer.addStream === 'function') {
                peer.addStream(localStream);
            } else {
                try {
                    peer.addStream(localStream);
                } catch (e) {
                    localStream && localStream.getTracks().forEach(function(track) {
                        peer.addTrack(track, localStream);
                    });
                }
            }
        });

        peer.oniceconnectionstatechange = peer.onsignalingstatechange = function() {
            var extra = self.extra;
            if (connection.peers[self.userid]) {
                extra = connection.peers[self.userid].extra || extra;
            }

            if (!peer) {
                return;
            }

            config.onPeerStateChanged({
                iceConnectionState: peer.iceConnectionState,
                iceGatheringState: peer.iceGatheringState,
                signalingState: peer.signalingState,
                extra: extra,
                userid: self.userid
            });

            if (peer && peer.iceConnectionState && peer.iceConnectionState.search(/closed|failed/gi) !== -1 && self.streams instanceof Array) {
                self.streams.forEach(function(stream) {
                    var streamEvent = connection.streamEvents[stream.id] || {
                        streamid: stream.id,
                        stream: stream,
                        type: 'remote'
                    };

                    connection.onstreamended(streamEvent);
                });
            }
        };

        var sdpConstraints = {
            OfferToReceiveAudio: !!localStreams.length,
            OfferToReceiveVideo: !!localStreams.length
        };

        if (config.localPeerSdpConstraints) sdpConstraints = config.localPeerSdpConstraints;

        defaults.sdpConstraints = setSdpConstraints(sdpConstraints);

        var streamObject;
        var dontDuplicate = {};

        var incomingStreamEvent = 'track';

        if (!window.enableAdapter) {
            incomingStreamEvent = 'addstream';
        }

        peer.addEventListener(incomingStreamEvent, function(event) {
            if (!event) return;

            if (incomingStreamEvent === 'track') {
                event.stream = event.streams[event.streams.length - 1];
            }

            if (dontDuplicate[event.stream.id]) return;
            dontDuplicate[event.stream.id] = event.stream.id;

            var streamsToShare = {};
            if (config.remoteSdp && config.remoteSdp.streamsToShare) {
                streamsToShare = config.remoteSdp.streamsToShare;
            } else if (config.streamsToShare) {
                streamsToShare = config.streamsToShare;
            }

            var streamToShare = streamsToShare[event.stream.id];
            if (streamToShare) {
                event.stream.isAudio = streamToShare.isAudio;
                event.stream.isVideo = streamToShare.isVideo;
                event.stream.isScreen = streamToShare.isScreen;
            } else {
                event.stream.isVideo = !!event.stream.getVideoTracks().length;
                event.stream.isAudio = !event.stream.isVideo;
                event.stream.isScreen = false;
            }

            event.stream.streamid = event.stream.id;
            if (DetectRTC.browser.name == 'Firefox' || !event.stream.stop) {
                event.stream.stop = function() {
                    var streamEndedEvent = 'ended';

                    if ('oninactive' in event.stream) {
                        streamEndedEvent = 'inactive';
                    }
                    fireEvent(event.stream, streamEndedEvent);
                };
            }
            allRemoteStreams[event.stream.id] = event.stream;
            config.onRemoteStream(event.stream);
        }, false);

        peer.onremovestream = function(event) {
            // this event doesn't works anymore
            event.stream.streamid = event.stream.id;

            if (allRemoteStreams[event.stream.id]) {
                delete allRemoteStreams[event.stream.id];
            }

            config.onRemoteStreamRemoved(event.stream);
        };

        this.addRemoteCandidate = function(remoteCandidate) {
            peer.addIceCandidate(new RTCIceCandidate(remoteCandidate));
        };

        function oldAddRemoteSdp(remoteSdp, cb) {
            cb = cb || function() {};

            remoteSdp.sdp = connection.processSdp(remoteSdp.sdp);
            peer.setRemoteDescription(new RTCSessionDescription(remoteSdp), cb, function(error) {
                console.error('setRemoteDescription 실패', '\n', error, '\n', remoteSdp.sdp);

                cb();
            });
        }

        this.addRemoteSdp = function(remoteSdp, cb) {
            cb = cb || function() {};

            if (!window.enableAdapter) {
                return oldAddRemoteSdp(remoteSdp, cb);
            }

            remoteSdp.sdp = connection.processSdp(remoteSdp.sdp);
            peer.setRemoteDescription(new RTCSessionDescription(remoteSdp)).then(cb, function(error) {
                console.error('setRemoteDescription 실패', '\n', error, '\n', remoteSdp.sdp);

                cb();
            });
        };

        var isOfferer = true;

        if (config.remoteSdp) {
            isOfferer = false;
        }

        this.createDataChannel = function() {
            var channel = peer.createDataChannel('sctp', {});
            setChannelEvents(channel);
        };

        if (connection.session.data === true && !renegotiatingPeer) {
            if (!isOfferer) {
                peer.ondatachannel = function(event) {
                    var channel = event.channel;
                    setChannelEvents(channel);
                };
            } else {
                this.createDataChannel();
            }
        }

        if (config.remoteSdp) {
            if (config.remoteSdp.remotePeerSdpConstraints) {
                sdpConstraints = config.remoteSdp.remotePeerSdpConstraints;
            }
            defaults.sdpConstraints = setSdpConstraints(sdpConstraints);
            this.addRemoteSdp(config.remoteSdp, function() {
                createOfferOrAnswer('createAnswer');
            });
        }

        function setChannelEvents(channel) {
            // force ArrayBuffer in Firefox; which uses "Blob" by default.
            channel.binaryType = 'arraybuffer';

            channel.onmessage = function(event) {
                config.onDataChannelMessage(event.data);
            };

            channel.onopen = function() {
                config.onDataChannelOpened(channel);
            };

            channel.onerror = function(error) {
                config.onDataChannelError(error);
            };

            channel.onclose = function(event) {
                config.onDataChannelClosed(event);
            };

            channel.internalSend = channel.send;
            channel.send = function(data) {
                if (channel.readyState !== 'open') {
                    return;
                }

                channel.internalSend(data);
            };

            peer.channel = channel;
        }

        if (connection.session.audio == 'two-way' || connection.session.video == 'two-way' || connection.session.screen == 'two-way') {
            defaults.sdpConstraints = setSdpConstraints({
                OfferToReceiveAudio: connection.session.audio == 'two-way' || (config.remoteSdp && config.remoteSdp.remotePeerSdpConstraints && config.remoteSdp.remotePeerSdpConstraints.OfferToReceiveAudio),
                OfferToReceiveVideo: connection.session.video == 'two-way' || connection.session.screen == 'two-way' || (config.remoteSdp && config.remoteSdp.remotePeerSdpConstraints && config.remoteSdp.remotePeerSdpConstraints.OfferToReceiveAudio)
            });
        }

        var streamsToShare = {};
        if (getLocalStreams().forEach) {
            getLocalStreams().forEach(function(stream) {
                streamsToShare[stream.streamid] = {
                    isAudio: !!stream.isAudio,
                    isVideo: !!stream.isVideo,
                    isScreen: !!stream.isScreen
                };
            });
        }

        function oldCreateOfferOrAnswer(_method) {
            peer[_method](function(localSdp) {
                localSdp.sdp = connection.processSdp(localSdp.sdp);
                peer.setLocalDescription(localSdp, function() {
                    if (!connection.trickleIce) return;

                    config.onLocalSdp({
                        type: localSdp.type,
                        sdp: localSdp.sdp,
                        remotePeerSdpConstraints: config.remotePeerSdpConstraints || false,
                        renegotiatingPeer: !!config.renegotiatingPeer || false,
                        connectionDescription: self.connectionDescription,
                        dontGetRemoteStream: !!config.dontGetRemoteStream,
                        extra: connection ? connection.extra : {},
                        streamsToShare: streamsToShare
                    });

                    connection.onSettingLocalDescription(self);
                }, function(error) {
                    console.error('setLocalDescription-error', error);
                });
            }, function(error) {
                console.error('sdp-' + _method + '-error', error);
            }, defaults.sdpConstraints);
        }

        function createOfferOrAnswer(_method) {
            if (!window.enableAdapter) {
                return oldCreateOfferOrAnswer(_method);
            }

            peer[_method](defaults.sdpConstraints).then(function(localSdp) {
                localSdp.sdp = connection.processSdp(localSdp.sdp);
                peer.setLocalDescription(localSdp).then(function() {
                    if (!connection.trickleIce) return;

                    config.onLocalSdp({
                        type: localSdp.type,
                        sdp: localSdp.sdp,
                        remotePeerSdpConstraints: config.remotePeerSdpConstraints || false,
                        renegotiatingPeer: !!config.renegotiatingPeer || false,
                        connectionDescription: self.connectionDescription,
                        dontGetRemoteStream: !!config.dontGetRemoteStream,
                        extra: connection ? connection.extra : {},
                        streamsToShare: streamsToShare
                    });

                    connection.onSettingLocalDescription(self);
                }, function(error) {
                    console.error('setLocalDescription 에러', error);
                });
            }, function(error) {
                console.error('sdp-error', error);
            });
        }

        if (isOfferer) {
            createOfferOrAnswer('createOffer');
        }

        peer.nativeClose = peer.close;
        peer.close = function() {
            if (!peer) {
                return;
            }

            try {
                if (peer.iceConnectionState.search(/closed|failed/gi) === -1) {
                    peer.getRemoteStreams().forEach(function(stream) {
                        var streamEndedEvent = 'ended';

                        if ('oninactive' in stream) {
                            streamEndedEvent = 'inactive';
                        }

                        fireEvent(stream, streamEndedEvent);
                    });
                }
                peer.nativeClose();
            } catch (e) {}

            peer = null;
            self.peer = null;
        };

        this.peer = peer;
    }

    // CodecsHandler.js

    var CodecsHandler = (function() {
        // "removeVPX" and "removeNonG722" methods are taken from github/mozilla/webrtc-landing
        function removeVPX(sdp) {
            if (!sdp || typeof sdp !== 'string') {
                throw 'Invalid arguments.';
            }

            // this method is NOT reliable

            sdp = sdp.replace('a=rtpmap:100 VP8/90000\r\n', '');
            sdp = sdp.replace('a=rtpmap:101 VP9/90000\r\n', '');

            sdp = sdp.replace(/m=video ([0-9]+) RTP\/SAVPF ([0-9 ]*) 100/g, 'm=video $1 RTP\/SAVPF $2');
            sdp = sdp.replace(/m=video ([0-9]+) RTP\/SAVPF ([0-9 ]*) 101/g, 'm=video $1 RTP\/SAVPF $2');

            sdp = sdp.replace(/m=video ([0-9]+) RTP\/SAVPF 100([0-9 ]*)/g, 'm=video $1 RTP\/SAVPF$2');
            sdp = sdp.replace(/m=video ([0-9]+) RTP\/SAVPF 101([0-9 ]*)/g, 'm=video $1 RTP\/SAVPF$2');

            sdp = sdp.replace('a=rtcp-fb:120 nack\r\n', '');
            sdp = sdp.replace('a=rtcp-fb:120 nack pli\r\n', '');
            sdp = sdp.replace('a=rtcp-fb:120 ccm fir\r\n', '');

            sdp = sdp.replace('a=rtcp-fb:101 nack\r\n', '');
            sdp = sdp.replace('a=rtcp-fb:101 nack pli\r\n', '');
            sdp = sdp.replace('a=rtcp-fb:101 ccm fir\r\n', '');

            return sdp;
        }

        function disableNACK(sdp) {
            if (!sdp || typeof sdp !== 'string') {
                throw 'Invalid arguments.';
            }

            sdp = sdp.replace('a=rtcp-fb:126 nack\r\n', '');
            sdp = sdp.replace('a=rtcp-fb:126 nack pli\r\n', 'a=rtcp-fb:126 pli\r\n');
            sdp = sdp.replace('a=rtcp-fb:97 nack\r\n', '');
            sdp = sdp.replace('a=rtcp-fb:97 nack pli\r\n', 'a=rtcp-fb:97 pli\r\n');

            return sdp;
        }

        function prioritize(codecMimeType, peer) {
            if (!peer || !peer.getSenders || !peer.getSenders().length) {
                return;
            }

            if (!codecMimeType || typeof codecMimeType !== 'string') {
                throw 'Invalid arguments.';
            }

            peer.getSenders().forEach(function(sender) {
                var params = sender.getParameters();
                for (var i = 0; i < params.codecs.length; i++) {
                    if (params.codecs[i].mimeType == codecMimeType) {
                        params.codecs.unshift(params.codecs.splice(i, 1));
                        break;
                    }
                }
                sender.setParameters(params);
            });
        }

        function removeNonG722(sdp) {
            return sdp.replace(/m=audio ([0-9]+) RTP\/SAVPF ([0-9 ]*)/g, 'm=audio $1 RTP\/SAVPF 9');
        }

        function setBAS(sdp, bandwidth, isScreen) {
            if (!bandwidth) {
                return sdp;
            }

            if (typeof isFirefox !== 'undefined' && isFirefox) {
                return sdp;
            }

            if (isScreen) {
                if (!bandwidth.screen) {
                    console.warn('It seems that you are not using bandwidth for screen. Screen sharing is expected to fail.');
                } else if (bandwidth.screen < 300) {
                    console.warn('It seems that you are using wrong bandwidth value for screen. Screen sharing is expected to fail.');
                }
            }

            // if screen; must use at least 300kbs
            if (bandwidth.screen && isScreen) {
                sdp = sdp.replace(/b=AS([^\r\n]+\r\n)/g, '');
                sdp = sdp.replace(/a=mid:video\r\n/g, 'a=mid:video\r\nb=AS:' + bandwidth.screen + '\r\n');
            }

            // remove existing bandwidth lines
            if (bandwidth.audio || bandwidth.video) {
                sdp = sdp.replace(/b=AS([^\r\n]+\r\n)/g, '');
            }

            if (bandwidth.audio) {
                sdp = sdp.replace(/a=mid:audio\r\n/g, 'a=mid:audio\r\nb=AS:' + bandwidth.audio + '\r\n');
            }

            if (bandwidth.screen) {
                sdp = sdp.replace(/a=mid:video\r\n/g, 'a=mid:video\r\nb=AS:' + bandwidth.screen + '\r\n');
            } else if (bandwidth.video) {
                sdp = sdp.replace(/a=mid:video\r\n/g, 'a=mid:video\r\nb=AS:' + bandwidth.video + '\r\n');
            }

            return sdp;
        }

        // Find the line in sdpLines that starts with |prefix|, and, if specified,
        // contains |substr| (case-insensitive search).
        function findLine(sdpLines, prefix, substr) {
            return findLineInRange(sdpLines, 0, -1, prefix, substr);
        }

        // Find the line in sdpLines[startLine...endLine - 1] that starts with |prefix|
        // and, if specified, contains |substr| (case-insensitive search).
        function findLineInRange(sdpLines, startLine, endLine, prefix, substr) {
            var realEndLine = endLine !== -1 ? endLine : sdpLines.length;
            for (var i = startLine; i < realEndLine; ++i) {
                if (sdpLines[i].indexOf(prefix) === 0) {
                    if (!substr ||
                        sdpLines[i].toLowerCase().indexOf(substr.toLowerCase()) !== -1) {
                        return i;
                    }
                }
            }
            return null;
        }

        // Gets the codec payload type from an a=rtpmap:X line.
        function getCodecPayloadType(sdpLine) {
            var pattern = new RegExp('a=rtpmap:(\\d+) \\w+\\/\\d+');
            var result = sdpLine.match(pattern);
            return (result && result.length === 2) ? result[1] : null;
        }

        function setVideoBitrates(sdp, params) {
            params = params || {};
            var xgoogle_min_bitrate = params.min;
            var xgoogle_max_bitrate = params.max;

            var sdpLines = sdp.split('\r\n');

            // VP8
            var vp8Index = findLine(sdpLines, 'a=rtpmap', 'VP8/90000');
            var vp8Payload;
            if (vp8Index) {
                vp8Payload = getCodecPayloadType(sdpLines[vp8Index]);
            }

            if (!vp8Payload) {
                return sdp;
            }

            var rtxIndex = findLine(sdpLines, 'a=rtpmap', 'rtx/90000');
            var rtxPayload;
            if (rtxIndex) {
                rtxPayload = getCodecPayloadType(sdpLines[rtxIndex]);
            }

            if (!rtxIndex) {
                return sdp;
            }

            var rtxFmtpLineIndex = findLine(sdpLines, 'a=fmtp:' + rtxPayload.toString());
            if (rtxFmtpLineIndex !== null) {
                var appendrtxNext = '\r\n';
                appendrtxNext += 'a=fmtp:' + vp8Payload + ' x-google-min-bitrate=' + (xgoogle_min_bitrate || '228') + '; x-google-max-bitrate=' + (xgoogle_max_bitrate || '228');
                sdpLines[rtxFmtpLineIndex] = sdpLines[rtxFmtpLineIndex].concat(appendrtxNext);
                sdp = sdpLines.join('\r\n');
            }

            return sdp;
        }

        function setOpusAttributes(sdp, params) {
            params = params || {};

            var sdpLines = sdp.split('\r\n');

            // Opus
            var opusIndex = findLine(sdpLines, 'a=rtpmap', 'opus/48000');
            var opusPayload;
            if (opusIndex) {
                opusPayload = getCodecPayloadType(sdpLines[opusIndex]);
            }

            if (!opusPayload) {
                return sdp;
            }

            var opusFmtpLineIndex = findLine(sdpLines, 'a=fmtp:' + opusPayload.toString());
            if (opusFmtpLineIndex === null) {
                return sdp;
            }

            var appendOpusNext = '';
            appendOpusNext += '; stereo=' + (typeof params.stereo != 'undefined' ? params.stereo : '1');
            appendOpusNext += '; sprop-stereo=' + (typeof params['sprop-stereo'] != 'undefined' ? params['sprop-stereo'] : '1');

            if (typeof params.maxaveragebitrate != 'undefined') {
                appendOpusNext += '; maxaveragebitrate=' + (params.maxaveragebitrate || 128 * 1024 * 8);
            }

            if (typeof params.maxplaybackrate != 'undefined') {
                appendOpusNext += '; maxplaybackrate=' + (params.maxplaybackrate || 128 * 1024 * 8);
            }

            if (typeof params.cbr != 'undefined') {
                appendOpusNext += '; cbr=' + (typeof params.cbr != 'undefined' ? params.cbr : '1');
            }

            if (typeof params.useinbandfec != 'undefined') {
                appendOpusNext += '; useinbandfec=' + params.useinbandfec;
            }

            if (typeof params.usedtx != 'undefined') {
                appendOpusNext += '; usedtx=' + params.usedtx;
            }

            if (typeof params.maxptime != 'undefined') {
                appendOpusNext += '\r\na=maxptime:' + params.maxptime;
            }

            sdpLines[opusFmtpLineIndex] = sdpLines[opusFmtpLineIndex].concat(appendOpusNext);

            sdp = sdpLines.join('\r\n');
            return sdp;
        }

        function preferVP9(sdp) {
            if (sdp.indexOf('SAVPF 96 98') === -1 || sdp.indexOf('VP9/90000') === -1) {
                return sdp;
            }

            return sdp.replace('SAVPF 96 98', 'SAVPF 98 96');
        }

        // forceStereoAudio => via webrtcexample.com
        // requires getUserMedia => echoCancellation:false
        function forceStereoAudio(sdp) {
            var sdpLines = sdp.split('\r\n');
            var fmtpLineIndex = null;
            for (var i = 0; i < sdpLines.length; i++) {
                if (sdpLines[i].search('opus/48000') !== -1) {
                    var opusPayload = extractSdp(sdpLines[i], /:(\d+) opus\/48000/i);
                    break;
                }
            }
            for (var i = 0; i < sdpLines.length; i++) {
                if (sdpLines[i].search('a=fmtp') !== -1) {
                    var payload = extractSdp(sdpLines[i], /a=fmtp:(\d+)/);
                    if (payload === opusPayload) {
                        fmtpLineIndex = i;
                        break;
                    }
                }
            }
            if (fmtpLineIndex === null) return sdp;
            sdpLines[fmtpLineIndex] = sdpLines[fmtpLineIndex].concat('; stereo=1; sprop-stereo=1');
            sdp = sdpLines.join('\r\n');
            return sdp;
        }

        return {
            removeVPX: removeVPX,
            disableNACK: disableNACK,
            prioritize: prioritize,
            removeNonG722: removeNonG722,
            setApplicationSpecificBandwidth: function(sdp, bandwidth, isScreen) {
                return setBAS(sdp, bandwidth, isScreen);
            },
            setVideoBitrates: function(sdp, params) {
                return setVideoBitrates(sdp, params);
            },
            setOpusAttributes: function(sdp, params) {
                return setOpusAttributes(sdp, params);
            },
            preferVP9: preferVP9,
            forceStereoAudio: forceStereoAudio
        };
    })();

    // backward compatibility
    window.BandwidthHandler = CodecsHandler;

    // OnIceCandidateHandler.js

    var OnIceCandidateHandler = (function() {
        function processCandidates(connection, icePair) {
            var candidate = icePair.candidate;

            var iceRestrictions = connection.candidates;
            var stun = iceRestrictions.stun;
            var turn = iceRestrictions.turn;

            if (!isNull(iceRestrictions.reflexive)) {
                stun = iceRestrictions.reflexive;
            }

            if (!isNull(iceRestrictions.relay)) {
                turn = iceRestrictions.relay;
            }

            if (!iceRestrictions.host && !!candidate.match(/typ host/g)) {
                return;
            }

            if (!turn && !!candidate.match(/typ relay/g)) {
                return;
            }

            if (!stun && !!candidate.match(/typ srflx/g)) {
                return;
            }

            var protocol = connection.iceProtocols;

            if (!protocol.udp && !!candidate.match(/ udp /g)) {
                return;
            }

            if (!protocol.tcp && !!candidate.match(/ tcp /g)) {
                return;
            }

            console.debug('나의 후보 페어들: ', candidate);

            return {
                candidate: candidate,
                sdpMid: icePair.sdpMid,
                sdpMLineIndex: icePair.sdpMLineIndex
            };
        }

        return {
            processCandidates: processCandidates
        };
    })();

    // IceServersHandler.js

    var IceServersHandler = (function() {
        function getIceServers(connection) {
            // resiprocate: 3344+4433
            var iceServers = [{
                'urls': [
                    'turn:webrtcweb.com:7788', // coTURN 7788+8877
                    'turn:webrtcweb.com:4455', // restund udp
                    'turn:webrtcweb.com:5544' // restund tcp
                ],
                'username': 'muazkh',
                'credential': 'muazkh'
            },
                {
                    'urls': [
                        'stun:stun.l.google.com:19302'
                    ]
                }
            ];

            if (typeof window.InstallTrigger !== 'undefined') {
                iceServers[0].urls = iceServers[0].urls.pop();
                iceServers[1].urls = iceServers[1].urls.pop();
            }

            return iceServers;
        }

        return {
            getIceServers: getIceServers
        };
    })();

    // getUserMediaHandler.js

    function setStreamType(constraints, stream) {
        if (constraints.mandatory && constraints.mandatory.chromeMediaSource) {
            stream.isScreen = true;
        } else if (constraints.mozMediaSource || constraints.mediaSource) {
            stream.isScreen = true;
        } else if (constraints.video) {
            stream.isVideo = true;
        } else if (constraints.audio) {
            stream.isAudio = true;
        }
    }

    // allow users to manage this object (to support re-capturing of screen/etc.)
    window.currentUserMediaRequest = {
        streams: [],
        mutex: false,
        queueRequests: [],
        remove: function(idInstance) {
            this.mutex = false;

            var stream = this.streams[idInstance];
            if (!stream) {
                return;
            }

            stream = stream.stream;

            var options = stream.currentUserMediaRequestOptions;

            if (this.queueRequests.indexOf(options)) {
                delete this.queueRequests[this.queueRequests.indexOf(options)];
                this.queueRequests = removeNullEntries(this.queueRequests);
            }

            this.streams[idInstance].stream = null;
            delete this.streams[idInstance];
        }
    };

    function getUserMediaHandler(options) {
        if (currentUserMediaRequest.mutex === true) {
            currentUserMediaRequest.queueRequests.push(options);
            return;
        }
        currentUserMediaRequest.mutex = true;

        // easy way to match
        var idInstance = JSON.stringify(options.localMediaConstraints);

        function streaming(stream, returnBack) {
            setStreamType(options.localMediaConstraints, stream);
            options.onGettingLocalMedia(stream, returnBack);

            var streamEndedEvent = 'ended';

            if ('oninactive' in stream) {
                streamEndedEvent = 'inactive';
            }
            stream.addEventListener(streamEndedEvent, function() {
                delete currentUserMediaRequest.streams[idInstance];

                currentUserMediaRequest.mutex = false;
                if (currentUserMediaRequest.queueRequests.indexOf(options)) {
                    delete currentUserMediaRequest.queueRequests[currentUserMediaRequest.queueRequests.indexOf(options)];
                    currentUserMediaRequest.queueRequests = removeNullEntries(currentUserMediaRequest.queueRequests);
                }
            }, false);

            currentUserMediaRequest.streams[idInstance] = {
                stream: stream
            };
            currentUserMediaRequest.mutex = false;

            if (currentUserMediaRequest.queueRequests.length) {
                getUserMediaHandler(currentUserMediaRequest.queueRequests.shift());
            }
        }

        if (currentUserMediaRequest.streams[idInstance]) {
            streaming(currentUserMediaRequest.streams[idInstance].stream, true);
        } else {
            var isBlackBerry = !!(/BB10|BlackBerry/i.test(navigator.userAgent || ''));
            if (isBlackBerry || typeof navigator.mediaDevices === 'undefined' || typeof navigator.mediaDevices.getUserMedia !== 'function') {
                navigator.getUserMedia = navigator.getUserMedia || navigator.webkitGetUserMedia || navigator.mozGetUserMedia;
                navigator.getUserMedia(options.localMediaConstraints, function(stream) {
                    stream.streamid = stream.streamid || stream.id || getRandomString();
                    stream.idInstance = idInstance;
                    streaming(stream);
                }, function(error) {
                    options.onLocalMediaError(error, options.localMediaConstraints);
                });
                return;
            }

            if (typeof navigator.mediaDevices === 'undefined') {
                navigator.getUserMedia = navigator.getUserMedia || navigator.webkitGetUserMedia || navigator.mozGetUserMedia;
                var getUserMediaSuccess = function() {};
                var getUserMediaFailure = function() {};

                var getUserMediaStream, getUserMediaError;
                navigator.mediaDevices = {
                    getUserMedia: function(hints) {
                        navigator.getUserMedia(hints, function(getUserMediaSuccess) {
                            getUserMediaSuccess(stream);
                            getUserMediaStream = stream;
                        }, function(error) {
                            getUserMediaFailure(error);
                            getUserMediaError = error;
                        });

                        return {
                            then: function(successCB) {
                                if (getUserMediaStream) {
                                    successCB(getUserMediaStream);
                                    return;
                                }

                                getUserMediaSuccess = successCB;

                                return {
                                    then: function(failureCB) {
                                        if (getUserMediaError) {
                                            failureCB(getUserMediaError);
                                            return;
                                        }

                                        getUserMediaFailure = failureCB;
                                    }
                                }
                            }
                        }
                    }
                };
            }

            navigator.mediaDevices.getUserMedia(options.localMediaConstraints).then(function(stream) {
                stream.streamid = stream.streamid || stream.id || getRandomString();
                stream.idInstance = idInstance;

                streaming(stream);
            }).catch(function(error) {
                options.onLocalMediaError(error, options.localMediaConstraints);
            });
        }
    }

    // StreamsHandler.js

    var StreamsHandler = (function() {
        function handleType(type) {
            if (!type) {
                return;
            }

            if (typeof type === 'string' || typeof type === 'undefined') {
                return type;
            }

            if (type.audio && type.video) {
                return null;
            }

            if (type.audio) {
                return 'audio';
            }

            if (type.video) {
                return 'video';
            }

            return;
        }

        function setHandlers(stream, syncAction, connection) {
            if (!stream || !stream.addEventListener) return;

            if (typeof syncAction == 'undefined' || syncAction == true) {
                var streamEndedEvent = 'ended';

                if ('oninactive' in stream) {
                    streamEndedEvent = 'inactive';
                }

                stream.addEventListener(streamEndedEvent, function() {
                    StreamsHandler.onSyncNeeded(this.streamid, streamEndedEvent);
                }, false);
            }

            stream.mute = function(type, isSyncAction) {
                type = handleType(type);

                if (typeof isSyncAction !== 'undefined') {
                    syncAction = isSyncAction;
                }

                if (typeof type == 'undefined' || type == 'audio') {
                    stream.getAudioTracks().forEach(function(track) {
                        track.enabled = false;
                        connection.streamEvents[stream.streamid].isAudioMuted = true;
                    });
                }

                if (typeof type == 'undefined' || type == 'video') {
                    stream.getVideoTracks().forEach(function(track) {
                        track.enabled = false;
                    });
                }

                if (typeof syncAction == 'undefined' || syncAction == true) {
                    StreamsHandler.onSyncNeeded(stream.streamid, 'mute', type);
                }

                connection.streamEvents[stream.streamid].muteType = type || 'both';

                fireEvent(stream, 'mute', type);
            };

            stream.unmute = function(type, isSyncAction) {
                type = handleType(type);

                if (typeof isSyncAction !== 'undefined') {
                    syncAction = isSyncAction;
                }

                graduallyIncreaseVolume();

                if (typeof type == 'undefined' || type == 'audio') {
                    stream.getAudioTracks().forEach(function(track) {
                        track.enabled = true;
                        connection.streamEvents[stream.streamid].isAudioMuted = false;
                    });
                }

                if (typeof type == 'undefined' || type == 'video') {
                    stream.getVideoTracks().forEach(function(track) {
                        track.enabled = true;
                    });

                    // make sure that video unmute doesn't affects audio
                    if (typeof type !== 'undefined' && type == 'video' && connection.streamEvents[stream.streamid].isAudioMuted) {
                        (function looper(times) {
                            if (!times) {
                                times = 0;
                            }

                            times++;

                            // check until five-seconds
                            if (times < 100 && connection.streamEvents[stream.streamid].isAudioMuted) {
                                stream.mute('audio');

                                setTimeout(function() {
                                    looper(times);
                                }, 50);
                            }
                        })();
                    }
                }

                if (typeof syncAction == 'undefined' || syncAction == true) {
                    StreamsHandler.onSyncNeeded(stream.streamid, 'unmute', type);
                }

                connection.streamEvents[stream.streamid].unmuteType = type || 'both';

                fireEvent(stream, 'unmute', type);
            };

            function graduallyIncreaseVolume() {
                if (!connection.streamEvents[stream.streamid].mediaElement) {
                    return;
                }

                var mediaElement = connection.streamEvents[stream.streamid].mediaElement;
                mediaElement.volume = 0;
                afterEach(200, 5, function() {
                    try {
                        mediaElement.volume += .20;
                    } catch (e) {
                        mediaElement.volume = 1;
                    }
                });
            }
        }

        function afterEach(setTimeoutInteval, numberOfTimes, callback, startedTimes) {
            startedTimes = (startedTimes || 0) + 1;
            if (startedTimes >= numberOfTimes) return;

            setTimeout(function() {
                callback();
                afterEach(setTimeoutInteval, numberOfTimes, callback, startedTimes);
            }, setTimeoutInteval);
        }

        return {
            setHandlers: setHandlers,
            onSyncNeeded: function(streamid, action, type) {}
        };
    })();

    // Last time updated at August 29, 2017, 08:32:23

    // Latest file can be found here: https://cdn.webrtc-experiment.com/Screen-Capturing.js

    // Muaz Khan     - www.MuazKhan.com
    // MIT License   - www.WebRTC-Experiment.com/licence
    // Documentation - https://github.com/muaz-khan/Chrome-Extensions/tree/master/Screen-Capturing.js
    // Demo          - https://www.webrtc-experiment.com/Screen-Capturing/

    // ___________________
    // Screen-Capturing.js

    // Listen for postMessage handler
    // postMessage is used to exchange "sourceId" between chrome extension and you webpage.
    // though, there are tons other options as well, e.g. XHR-signaling, websockets, etc.
    window.addEventListener('message', function(event) {
        if (event.origin != window.location.origin) {
            return;
        }

        onMessageCallback(event.data);
    });

    // via: https://bugs.chromium.org/p/chromium/issues/detail?id=487935#c17
    // you can capture screen on Android Chrome >= 55 with flag: "Experimental ScreenCapture android"
    window.IsAndroidChrome = false;
    try {
        if (navigator.userAgent.toLowerCase().indexOf("android") > -1 && /Chrome/.test(navigator.userAgent) && /Google Inc/.test(navigator.vendor)) {
            window.IsAndroidChrome = true;
        }
    } catch (e) {}

    // and the function that handles received messages

    function onMessageCallback(data) {
        // "cancel" button is clicked
        if (data == 'PermissionDeniedError') {
            chromeMediaSource = 'PermissionDeniedError';
            if (screenCallback) {
                return screenCallback('PermissionDeniedError');
            } else {
                throw new Error('PermissionDeniedError: User rejected to share his screen.');
            }
        }

        // extension notified his presence
        if (data == 'rtcmulticonnection-extension-loaded') {
            chromeMediaSource = 'desktop';
        }

        // extension shared temp sourceId
        if (data.sourceId && screenCallback) {
            sourceId = data.sourceId;
            screenCallback(sourceId);
        }
    }

    // global variables
    var chromeMediaSource = 'screen';
    var sourceId;
    var screenCallback;

    // this method can be used to check if chrome extension is installed & enabled.
    function isChromeExtensionAvailable(callback) {
        if (!callback) return;

        if (DetectRTC.browser.name === 'Firefox') return isFirefoxExtensionAvailable(callback);

        if (window.IsAndroidChrome) {
            chromeMediaSource = 'screen';
            callback(true);
            return;
        }

        if (chromeMediaSource == 'desktop') {
            callback(true);
            return;
        }

        // ask extension if it is available
        window.postMessage('are-you-there', '*');

        setTimeout(function() {
            if (chromeMediaSource == 'screen') {
                callback(false);
            } else callback(true);
        }, 2000);
    }

    function isFirefoxExtensionAvailable(callback) {
        if (!callback) return;

        if (DetectRTC.browser.name !== 'Firefox') return isChromeExtensionAvailable(callback);

        var isFirefoxAddonResponded = false;

        function messageCallback(event) {
            var addonMessage = event.data;

            if (!addonMessage || typeof addonMessage.isScreenCapturingEnabled === 'undefined') return;

            isFirefoxAddonResponded = true;

            if (addonMessage.isScreenCapturingEnabled === true) {
                callback(true);
            } else {
                callback(false);
            }

            window.removeEventListener("message", messageCallback, false);
        }

        window.addEventListener("message", messageCallback, false);

        window.postMessage({
            checkIfScreenCapturingEnabled: true,
            domains: [document.domain]
        }, "*");

        setTimeout(function() {
            if (!isFirefoxAddonResponded) {
                callback(true); // can be old firefox extension
            }
        }, 2000); // wait 2-seconds-- todo: is this enough limit?
    }

    // this function can be used to get "source-id" from the extension
    function getSourceId(callback, audioPlusTab) {
        if (!callback) throw '"callback" parameter is mandatory.';
        if (sourceId) {
            callback(sourceId);
            sourceId = null;
            return;
        }

        screenCallback = callback;

        if (!!audioPlusTab) {
            window.postMessage('audio-plus-tab', '*');
            return;
        }
        window.postMessage('get-sourceId', '*');
    }

    function getChromeExtensionStatus(extensionid, callback) {
        if (window.IsAndroidChrome) {
            chromeMediaSource = 'screen';
            callback('installed-enabled');
            return;
        }

        if (arguments.length != 2) {
            callback = extensionid;
            extensionid = window.RMCExtensionID || 'ajhifddimkapgcifgcodmmfdlknahffk'; // default extension-id
        }

        if (DetectRTC.browser.name === 'Firefox') return callback('not-chrome');

        var image = document.createElement('img');
        image.src = 'chrome-extension://' + extensionid + '/icon.png';
        image.onload = function() {
            sourceId = null;
            chromeMediaSource = 'screen';
            window.postMessage('are-you-there', '*');
            setTimeout(function() {
                if (chromeMediaSource == 'screen') {
                    callback(extensionid == extensionid ? 'installed-enabled' : 'installed-disabled');
                } else callback('installed-enabled');
            }, 2000);
        };
        image.onerror = function() {
            callback('not-installed');
        };
    }

    function getAspectRatio(w, h) {
        function gcd(a, b) {
            return (b == 0) ? a : gcd(b, a % b);
        }
        var r = gcd(w, h);
        return (w / r) / (h / r);
    }

    // this function explains how to use above methods/objects
    function getScreenConstraints(callback, audioPlusTab) {
        var firefoxScreenConstraints = {
            mozMediaSource: 'window',
            mediaSource: 'window'
        };

        if (DetectRTC.browser.name === 'Firefox') return callback(null, firefoxScreenConstraints);

        // support recapture again & again
        sourceId = null;

        isChromeExtensionAvailable(function(isAvailable) {
            // this statement defines getUserMedia constraints
            // that will be used to capture content of screen
            var screen_constraints = {
                mandatory: {
                    chromeMediaSource: chromeMediaSource,
                    maxWidth: screen.width,
                    maxHeight: screen.height,
                    minWidth: screen.width,
                    minHeight: screen.height,
                    minAspectRatio: getAspectRatio(screen.width, screen.height),
                    maxAspectRatio: getAspectRatio(screen.width, screen.height),
                    minFrameRate: 64,
                    maxFrameRate: 128
                },
                optional: []
            };

            if (window.IsAndroidChrome) {
                // now invoking native getUserMedia API
                callback(null, screen_constraints);
                return;
            }

            // this statement verifies chrome extension availability
            // if installed and available then it will invoke extension API
            // otherwise it will fallback to command-line based screen capturing API
            if (chromeMediaSource == 'desktop' && !sourceId) {
                getSourceId(function() {
                    screen_constraints.mandatory.chromeMediaSourceId = sourceId;
                    callback(sourceId == 'PermissionDeniedError' ? sourceId : null, screen_constraints);
                    sourceId = null;
                }, audioPlusTab);
                return;
            }

            // this statement sets gets 'sourceId" and sets "chromeMediaSourceId"
            if (chromeMediaSource == 'desktop') {
                screen_constraints.mandatory.chromeMediaSourceId = sourceId;
            }

            sourceId = null;
            chromeMediaSource = 'screen'; // maybe this line is redundant?
            screenCallback = null;

            // now invoking native getUserMedia API
            callback(null, screen_constraints);
        });
    }

    // TextReceiver.js & TextSender.js

    function TextReceiver(connection) {
        var content = {};

        function receive(data, userid, extra) {
            // uuid is used to uniquely identify sending instance
            var uuid = data.uuid;
            if (!content[uuid]) {
                content[uuid] = [];
            }

            content[uuid].push(data.message);

            if (data.last) {
                var message = content[uuid].join('');
                if (data.isobject) {
                    message = JSON.parse(message);
                }

                // latency detection
                var receivingTime = new Date().getTime();
                var latency = receivingTime - data.sendingTime;

                var e = {
                    data: message,
                    userid: userid,
                    extra: extra,
                    latency: latency
                };

                if (connection.autoTranslateText) {
                    e.original = e.data;
                    connection.Translator.TranslateText(e.data, function(translatedText) {
                        e.data = translatedText;
                        connection.onmessage(e);
                    });
                } else {
                    connection.onmessage(e);
                }

                delete content[uuid];
            }
        }

        return {
            receive: receive
        };
    }

    // TextSender.js
    var TextSender = {
        send: function(config) {
            var connection = config.connection;

            var channel = config.channel,
                remoteUserId = config.remoteUserId,
                initialText = config.text,
                packetSize = connection.chunkSize || 1000,
                textToTransfer = '',
                isobject = false;

            if (!isString(initialText)) {
                isobject = true;
                initialText = JSON.stringify(initialText);
            }

            // uuid is used to uniquely identify sending instance
            var uuid = getRandomString();
            var sendingTime = new Date().getTime();

            sendText(initialText);

            function sendText(textMessage, text) {
                var data = {
                    type: 'text',
                    uuid: uuid,
                    sendingTime: sendingTime
                };

                if (textMessage) {
                    text = textMessage;
                    data.packets = parseInt(text.length / packetSize);
                }

                if (text.length > packetSize) {
                    data.message = text.slice(0, packetSize);
                } else {
                    data.message = text;
                    data.last = true;
                    data.isobject = isobject;
                }

                channel.send(data, remoteUserId);

                textToTransfer = text.slice(data.message.length);

                if (textToTransfer.length) {
                    setTimeout(function() {
                        sendText(null, textToTransfer);
                    }, connection.chunkInterval || 100);
                }
            }
        }
    };

    // FileProgressBarHandler.js

    var FileProgressBarHandler = (function() {
        function handle(connection) {
            var progressHelper = {};

            // www.RTCMultiConnection.org/docs/onFileStart/
            connection.onFileStart = function(file) {
                var div = document.createElement('div');
                div.title = file.name;
                div.innerHTML = '<label>0%</label> <progress></progress>';

                if (file.remoteUserId) {
                    div.innerHTML += ' (Sharing with:' + file.remoteUserId + ')';
                }

                if (!connection.filesContainer) {
                    connection.filesContainer = document.body || document.documentElement;
                }

                connection.filesContainer.insertBefore(div, connection.filesContainer.firstChild);

                if (!file.remoteUserId) {
                    progressHelper[file.uuid] = {
                        div: div,
                        progress: div.querySelector('progress'),
                        label: div.querySelector('label')
                    };
                    progressHelper[file.uuid].progress.max = file.maxChunks;
                    return;
                }

                if (!progressHelper[file.uuid]) {
                    progressHelper[file.uuid] = {};
                }

                progressHelper[file.uuid][file.remoteUserId] = {
                    div: div,
                    progress: div.querySelector('progress'),
                    label: div.querySelector('label')
                };
                progressHelper[file.uuid][file.remoteUserId].progress.max = file.maxChunks;
            };

            // www.RTCMultiConnection.org/docs/onFileProgress/
            connection.onFileProgress = function(chunk) {
                var helper = progressHelper[chunk.uuid];
                if (!helper) {
                    return;
                }
                if (chunk.remoteUserId) {
                    helper = progressHelper[chunk.uuid][chunk.remoteUserId];
                    if (!helper) {
                        return;
                    }
                }

                helper.progress.value = chunk.currentPosition || chunk.maxChunks || helper.progress.max;
                updateLabel(helper.progress, helper.label);
            };

            // www.RTCMultiConnection.org/docs/onFileEnd/
            connection.onFileEnd = function(file) {
                var helper = progressHelper[file.uuid];
                if (!helper) {
                    console.error('No such progress-helper element exist.', file);
                    return;
                }

                if (file.remoteUserId) {
                    helper = progressHelper[file.uuid][file.remoteUserId];
                    if (!helper) {
                        return;
                    }
                }

                var div = helper.div;

                // 다운로드 링크와 파일 미리보기를 띄우는 부분
                // 이미지 파일 미리보기를 함께 띄우려면 <img src="' + file.url + '" title="' + file.name + '" style="max-width: 80%;"> 를 추가한다
                // 이미지 이외의 파일 미리보기를 함께 띄우려면 <iframe src="' + file.url + '" title="' + file.name + '" style="width: 80%;border: 0;height: inherit;margin-top:1em;"></iframe> 를 추가한다

                if (file.type.indexOf('image') != -1) {
                    div.innerHTML = '<a href="' + file.url + '" download="' + file.name + '">Download <strong style="color:red;">' + file.name + '</strong></a>';
                } else {
                    div.innerHTML = '<a href="' + file.url + '" download="' + file.name + '">Download <strong style="color:red;">' + file.name + '</strong></a>';
                }
            };

            function updateLabel(progress, label) {
                if (progress.position === -1) {
                    return;
                }

                var position = +progress.position.toFixed(2).split('.')[1] || 100;
                label.innerHTML = position + '%';
            }
        }

        return {
            handle: handle
        };
    })();

    // RTCMultiConnection.js 기본 동작부분
    (function(connection) {
        forceOptions = forceOptions || {
            useDefaultDevices: true
        };

        connection.channel = connection.sessionid = (roomid || location.href.replace(/\/|:|#|\?|\$|\^|%|\.|`|~|!|\+|@|\[|\||]|\|*. /g, '').split('\n').join('').split('\r').join('')) + '';

        var mPeer = new MultiPeers(connection);

        var preventDuplicateOnStreamEvents = {};
        mPeer.onGettingLocalMedia = function(stream) {
            if (preventDuplicateOnStreamEvents[stream.streamid]) {
                return;
            }
            preventDuplicateOnStreamEvents[stream.streamid] = true;

            try {
                stream.type = 'local';
            } catch (e) {}

            connection.setStreamEndHandler(stream);

            getRMCMediaElement(stream, function(mediaElement) {
                mediaElement.id = stream.streamid;
                mediaElement.muted = true;
                mediaElement.volume = 0;

                if (connection.attachStreams.indexOf(stream) === -1) {
                    connection.attachStreams.push(stream);
                }

                if (typeof StreamsHandler !== 'undefined') {
                    StreamsHandler.setHandlers(stream, true, connection);
                }

                connection.streamEvents[stream.streamid] = {
                    stream: stream,
                    type: 'local',
                    mediaElement: mediaElement,
                    userid: connection.userid,
                    extra: connection.extra,
                    streamid: stream.streamid,
                    isAudioMuted: true
                };

                setHarkEvents(connection, connection.streamEvents[stream.streamid]);
                setMuteHandlers(connection, connection.streamEvents[stream.streamid]);

                connection.onstream(connection.streamEvents[stream.streamid]);
            }, connection);
        };

        mPeer.onGettingRemoteMedia = function(stream, remoteUserId) {
            try {
                stream.type = 'remote';
            } catch (e) {}

            connection.setStreamEndHandler(stream, 'remote-stream');

            getRMCMediaElement(stream, function(mediaElement) {
                mediaElement.id = stream.streamid;

                if (typeof StreamsHandler !== 'undefined') {
                    StreamsHandler.setHandlers(stream, false, connection);
                }

                connection.streamEvents[stream.streamid] = {
                    stream: stream,
                    type: 'remote',
                    userid: remoteUserId,
                    extra: connection.peers[remoteUserId] ? connection.peers[remoteUserId].extra : {},
                    mediaElement: mediaElement,
                    streamid: stream.streamid
                };

                setMuteHandlers(connection, connection.streamEvents[stream.streamid]);

                connection.onstream(connection.streamEvents[stream.streamid]);
            }, connection);
        };

        mPeer.onRemovingRemoteMedia = function(stream, remoteUserId) {
            var streamEvent = connection.streamEvents[stream.streamid];
            if (!streamEvent) {
                streamEvent = {
                    stream: stream,
                    type: 'remote',
                    userid: remoteUserId,
                    extra: connection.peers[remoteUserId] ? connection.peers[remoteUserId].extra : {},
                    streamid: stream.streamid,
                    mediaElement: connection.streamEvents[stream.streamid] ? connection.streamEvents[stream.streamid].mediaElement : null
                };
            }

            if (connection.peersBackup[streamEvent.userid]) {
                streamEvent.extra = connection.peersBackup[streamEvent.userid].extra;
            }

            connection.onstreamended(streamEvent);

            delete connection.streamEvents[stream.streamid];
        };

        mPeer.onNegotiationNeeded = function(message, remoteUserId, callback) {
            remoteUserId = remoteUserId || message.remoteUserId;
            connectSocket(function() {
                connection.socket.emit(connection.socketMessageEvent, 'password' in message ? message : {
                    remoteUserId: remoteUserId,
                    message: message,
                    sender: connection.userid
                }, callback || function() {});
            });
        };

        function onUserLeft(remoteUserId) {
            connection.deletePeer(remoteUserId);
        }

        mPeer.onUserLeft = onUserLeft;
        mPeer.disconnectWith = function(remoteUserId, callback) {
            if (connection.socket) {
                connection.socket.emit('disconnect-with', remoteUserId, callback || function() {});
            }

            connection.deletePeer(remoteUserId);
        };

        connection.broadcasters = [];

        connection.socketOptions = {
            // 'force new connection': true, // For SocketIO version < 1.0
            // 'forceNew': true, // For SocketIO version >= 1.0
            'transport': 'polling' // fixing transport:unknown issues
        };

        function connectSocket(connectCallback) {
            connection.socketAutoReConnect = true;

            if (connection.socket) { // todo: check here readySate/etc. to make sure socket is still opened
                if (connectCallback) {
                    connectCallback(connection.socket);
                }
                return;
            }

            if (typeof SocketConnection === 'undefined') {
                if (typeof FirebaseConnection !== 'undefined') {
                    window.SocketConnection = FirebaseConnection;
                } else if (typeof PubNubConnection !== 'undefined') {
                    window.SocketConnection = PubNubConnection;
                } else {
                    throw 'SocketConnection.js seems missed.';
                }
            }

            new SocketConnection(connection, function(s) {
                if (connectCallback) {
                    connectCallback(connection.socket);
                }
            });
        }

        connection.openOrJoin = function(localUserid, password) {
            connection.checkPresence(localUserid, function(isRoomExists, roomid) {
                if (typeof password === 'function') {
                    password(isRoomExists, roomid);
                    password = null;
                }

                if (isRoomExists) {
                    connection.sessionid = roomid;

                    var localPeerSdpConstraints = false;
                    var remotePeerSdpConstraints = false;
                    var isOneWay = !!connection.session.oneway;
                    var isDataOnly = isData(connection.session);

                    remotePeerSdpConstraints = {
                        OfferToReceiveAudio: connection.sdpConstraints.mandatory.OfferToReceiveAudio,
                        OfferToReceiveVideo: connection.sdpConstraints.mandatory.OfferToReceiveVideo
                    }

                    localPeerSdpConstraints = {
                        OfferToReceiveAudio: isOneWay ? !!connection.session.audio : connection.sdpConstraints.mandatory.OfferToReceiveAudio,
                        OfferToReceiveVideo: isOneWay ? !!connection.session.video || !!connection.session.screen : connection.sdpConstraints.mandatory.OfferToReceiveVideo
                    }

                    var connectionDescription = {
                        remoteUserId: connection.sessionid,
                        message: {
                            newParticipationRequest: true,
                            isOneWay: isOneWay,
                            isDataOnly: isDataOnly,
                            localPeerSdpConstraints: localPeerSdpConstraints,
                            remotePeerSdpConstraints: remotePeerSdpConstraints
                        },
                        sender: connection.userid,
                        password: password || false
                    };

                    beforeJoin(connectionDescription.message, function() {
                        mPeer.onNegotiationNeeded(connectionDescription);
                    });
                    return;
                }

                var oldUserId = connection.userid;
                connection.userid = connection.sessionid = localUserid || connection.sessionid;
                connection.userid += '';

                connection.socket.emit('changed-uuid', connection.userid);

                if (password) {
                    connection.socket.emit('set-password', password);
                }

                connection.isInitiator = true;

                if (isData(connection.session)) {
                    return;
                }

                connection.captureUserMedia();
            });
        };

        connection.open = function(localUserid, isPublicModerator) {
            var oldUserId = connection.userid;
            connection.userid = connection.sessionid = localUserid || connection.sessionid;
            connection.userid += '';

            connection.isInitiator = true;

            connectSocket(function() {
                connection.socket.emit('changed-uuid', connection.userid);

                if (isPublicModerator == true) {
                    connection.becomePublicModerator();
                }

                if (isData(connection.session)) {
                    if (typeof isPublicModerator === 'function') {
                        isPublicModerator();
                    }
                    return;
                }

                connection.captureUserMedia(typeof isPublicModerator === 'function' ? isPublicModerator : null);
            });
        };

        connection.becomePublicModerator = function() {
            if (!connection.isInitiator) return;
            connection.socket.emit('become-a-public-moderator');
        };

        connection.dontMakeMeModerator = function() {
            connection.socket.emit('dont-make-me-moderator');
        };

        connection.deletePeer = function(remoteUserId) {
            if (!remoteUserId) {
                return;
            }

            var eventObject = {
                userid: remoteUserId,
                extra: connection.peers[remoteUserId] ? connection.peers[remoteUserId].extra : {}
            };

            if (connection.peersBackup[eventObject.userid]) {
                eventObject.extra = connection.peersBackup[eventObject.userid].extra;
            }

            connection.onleave(eventObject);

            if (!!connection.peers[remoteUserId]) {
                connection.peers[remoteUserId].streams.forEach(function(stream) {
                    stream.stop();
                });

                var peer = connection.peers[remoteUserId].peer;
                if (peer && peer.iceConnectionState !== 'closed') {
                    try {
                        peer.close();
                    } catch (e) {}
                }

                if (connection.peers[remoteUserId]) {
                    connection.peers[remoteUserId].peer = null;
                    delete connection.peers[remoteUserId];
                }
            }

            if (connection.broadcasters.indexOf(remoteUserId) !== -1) {
                var newArray = [];
                connection.broadcasters.forEach(function(broadcaster) {
                    if (broadcaster !== remoteUserId) {
                        newArray.push(broadcaster);
                    }
                });
                connection.broadcasters = newArray;
                keepNextBroadcasterOnServer();
            }
        };

        connection.rejoin = function(connectionDescription) {
            if (connection.isInitiator || !connectionDescription || !Object.keys(connectionDescription).length) {
                return;
            }

            var extra = {};

            if (connection.peers[connectionDescription.remoteUserId]) {
                extra = connection.peers[connectionDescription.remoteUserId].extra;
                connection.deletePeer(connectionDescription.remoteUserId);
            }

            if (connectionDescription && connectionDescription.remoteUserId) {
                connection.join(connectionDescription.remoteUserId);

                connection.onReConnecting({
                    userid: connectionDescription.remoteUserId,
                    extra: extra
                });
            }
        };

        connection.join = connection.connect = function(remoteUserId, options) {
            connection.sessionid = (remoteUserId ? remoteUserId.sessionid || remoteUserId.remoteUserId || remoteUserId : false) || connection.sessionid;
            connection.sessionid += '';

            var localPeerSdpConstraints = false;
            var remotePeerSdpConstraints = false;
            var isOneWay = false;
            var isDataOnly = false;

            if ((remoteUserId && remoteUserId.session) || !remoteUserId || typeof remoteUserId === 'string') {
                var session = remoteUserId ? remoteUserId.session || connection.session : connection.session;

                isOneWay = !!session.oneway;
                isDataOnly = isData(session);

                remotePeerSdpConstraints = {
                    OfferToReceiveAudio: connection.sdpConstraints.mandatory.OfferToReceiveAudio,
                    OfferToReceiveVideo: connection.sdpConstraints.mandatory.OfferToReceiveVideo
                };

                localPeerSdpConstraints = {
                    OfferToReceiveAudio: isOneWay ? !!connection.session.audio : connection.sdpConstraints.mandatory.OfferToReceiveAudio,
                    OfferToReceiveVideo: isOneWay ? !!connection.session.video || !!connection.session.screen : connection.sdpConstraints.mandatory.OfferToReceiveVideo
                };
            }

            options = options || {};

            var cb = function() {};
            if (typeof options === 'function') {
                cb = options;
                options = {};
            }

            if (typeof options.localPeerSdpConstraints !== 'undefined') {
                localPeerSdpConstraints = options.localPeerSdpConstraints;
            }

            if (typeof options.remotePeerSdpConstraints !== 'undefined') {
                remotePeerSdpConstraints = options.remotePeerSdpConstraints;
            }

            if (typeof options.isOneWay !== 'undefined') {
                isOneWay = options.isOneWay;
            }

            if (typeof options.isDataOnly !== 'undefined') {
                isDataOnly = options.isDataOnly;
            }

            var connectionDescription = {
                remoteUserId: connection.sessionid,
                message: {
                    newParticipationRequest: true,
                    isOneWay: isOneWay,
                    isDataOnly: isDataOnly,
                    localPeerSdpConstraints: localPeerSdpConstraints,
                    remotePeerSdpConstraints: remotePeerSdpConstraints
                },
                sender: connection.userid,
                password: false
            };

            beforeJoin(connectionDescription.message, function() {
                connectSocket(function() {
                    if (!!connection.peers[connection.sessionid]) {
                        // on socket disconnect & reconnect
                        return;
                    }

                    mPeer.onNegotiationNeeded(connectionDescription);
                    cb();
                });
            });
            return connectionDescription;
        };

        function beforeJoin(userPreferences, callback) {
            if (connection.dontCaptureUserMedia || userPreferences.isDataOnly) {
                callback();
                return;
            }

            var localMediaConstraints = {};

            if (userPreferences.localPeerSdpConstraints.OfferToReceiveAudio) {
                localMediaConstraints.audio = connection.mediaConstraints.audio;
            }

            if (userPreferences.localPeerSdpConstraints.OfferToReceiveVideo) {
                localMediaConstraints.video = connection.mediaConstraints.video;
            }

            var session = userPreferences.session || connection.session;

            if (session.oneway && session.audio !== 'two-way' && session.video !== 'two-way' && session.screen !== 'two-way') {
                callback();
                return;
            }

            if (session.oneway && session.audio && session.audio === 'two-way') {
                session = {
                    audio: true
                };
            }

            if (session.audio || session.video || session.screen) {
                if (session.screen) {
                    connection.getScreenConstraints(function(error, screen_constraints) {
                        connection.invokeGetUserMedia({
                            audio: isAudioPlusTab(connection) ? getAudioScreenConstraints(screen_constraints) : false,
                            video: screen_constraints,
                            isScreen: true
                        }, (session.audio || session.video) && !isAudioPlusTab(connection) ? connection.invokeGetUserMedia(null, callback) : callback);
                    });
                } else if (session.audio || session.video) {
                    connection.invokeGetUserMedia(null, callback, session);
                }
            }
        }

        connection.connectWithAllParticipants = function(remoteUserId) {
            mPeer.onNegotiationNeeded('connectWithAllParticipants', remoteUserId || connection.sessionid);
        };

        connection.removeFromBroadcastersList = function(remoteUserId) {
            mPeer.onNegotiationNeeded('removeFromBroadcastersList', remoteUserId || connection.sessionid);

            connection.peers.getAllParticipants(remoteUserId || connection.sessionid).forEach(function(participant) {
                mPeer.onNegotiationNeeded('dropPeerConnection', participant);
                connection.deletePeer(participant);
            });

            connection.attachStreams.forEach(function(stream) {
                stream.stop();
            });
        };

        connection.getUserMedia = connection.captureUserMedia = function(callback, sessionForced) {
            callback = callback || function() {};
            var session = sessionForced || connection.session;

            if (connection.dontCaptureUserMedia || isData(session)) {
                callback();
                return;
            }

            if (session.audio || session.video || session.screen) {
                if (session.screen) {
                    connection.getScreenConstraints(function(error, screen_constraints) {
                        if (error) {
                            throw error;
                        }

                        connection.invokeGetUserMedia({
                            audio: isAudioPlusTab(connection) ? getAudioScreenConstraints(screen_constraints) : false,
                            video: screen_constraints,
                            isScreen: true
                        }, function(stream) {
                            if ((session.audio || session.video) && !isAudioPlusTab(connection)) {
                                var nonScreenSession = {};
                                for (var s in session) {
                                    if (s !== 'screen') {
                                        nonScreenSession[s] = session[s];
                                    }
                                }
                                connection.invokeGetUserMedia(sessionForced, callback, nonScreenSession);
                                return;
                            }
                            callback(stream);
                        });
                    });
                } else if (session.audio || session.video) {
                    connection.invokeGetUserMedia(sessionForced, callback, session);
                }
            }
        };

        function beforeUnload(shiftModerationControlOnLeave, dontCloseSocket) {
            if (!connection.closeBeforeUnload) {
                return;
            }

            if (connection.isInitiator === true) {
                connection.dontMakeMeModerator();
            }

            connection.peers.getAllParticipants().forEach(function(participant) {
                mPeer.onNegotiationNeeded({
                    userLeft: true
                }, participant);

                if (connection.peers[participant] && connection.peers[participant].peer) {
                    connection.peers[participant].peer.close();
                }

                delete connection.peers[participant];
            });

            if (!dontCloseSocket) {
                connection.closeSocket();
            }

            connection.broadcasters = [];
            connection.isInitiator = false;
        }

        connection.closeBeforeUnload = true;
        window.addEventListener('beforeunload', beforeUnload, false);

        connection.userid = getRandomString();
        connection.changeUserId = function(newUserId, callback) {
            callback = callback || function() {};
            connection.userid = newUserId || getRandomString();
            connection.socket.emit('changed-uuid', connection.userid, callback);
        };

        connection.extra = {
            // userName: prompt('Please enter your name.')
        };

        connection.attachStreams = [];

        connection.session = {
            audio: true,
            video: true
        };

        connection.enableFileSharing = false;

        // all values in kbps
        connection.bandwidth = {
            screen: false,
            audio: false,
            video: false
        };

        connection.codecs = {
            audio: 'opus',
            video: 'VP9'
        };

        connection.processSdp = function(sdp) {
            if (DetectRTC.browser.name === 'Firefox') {
                return sdp;
            }

            if (connection.bandwidth.video || connection.bandwidth.screen) {
                sdp = CodecsHandler.setApplicationSpecificBandwidth(sdp, connection.bandwidth, !!connection.session.screen);
            }

            if (connection.bandwidth.video) {
                sdp = CodecsHandler.setVideoBitrates(sdp, {
                    min: connection.bandwidth.video * 8 * 1024,
                    max: connection.bandwidth.video * 8 * 1024
                });
            }

            if (connection.bandwidth.audio) {
                sdp = CodecsHandler.setOpusAttributes(sdp, {
                    maxaveragebitrate: connection.bandwidth.audio * 8 * 1024,
                    maxplaybackrate: connection.bandwidth.audio * 8 * 1024,
                    stereo: 1,
                    maxptime: 3
                });
            }

            if (connection.codecs.video === 'VP9') {
                sdp = CodecsHandler.preferVP9(sdp);
            }

            if (connection.codecs.video === 'H264') {
                sdp = CodecsHandler.removeVPX(sdp);
            }

            if (connection.codecs.audio === 'G722') {
                sdp = CodecsHandler.removeNonG722(sdp);
            }

            return sdp;
        };

        if (typeof CodecsHandler !== 'undefined') {
            connection.BandwidthHandler = connection.CodecsHandler = CodecsHandler;
        }

        connection.mediaConstraints = {
            audio: {
                mandatory: {},
                optional: connection.bandwidth.audio ? [{
                    bandwidth: connection.bandwidth.audio * 8 * 1024 || 128 * 8 * 1024
                }] : []
            },
            video: {
                mandatory: {},
                optional: connection.bandwidth.video ? [{
                    bandwidth: connection.bandwidth.video * 8 * 1024 || 128 * 8 * 1024
                }, {
                    facingMode: 'user'
                }] : [{
                    facingMode: 'user'
                }]
            }
        };

        if (DetectRTC.browser.name === 'Firefox') {
            connection.mediaConstraints = {
                audio: true,
                video: true
            };
        }

        if (!forceOptions.useDefaultDevices && !DetectRTC.isMobileDevice) {
            DetectRTC.load(function() {
                var lastAudioDevice, lastVideoDevice;
                // it will force RTCMultiConnection to capture last-devices
                // i.e. if external microphone is attached to system, we should prefer it over built-in devices.
                DetectRTC.MediaDevices.forEach(function(device) {
                    if (device.kind === 'audioinput' && connection.mediaConstraints.audio !== false) {
                        lastAudioDevice = device;
                    }

                    if (device.kind === 'videoinput' && connection.mediaConstraints.video !== false) {
                        lastVideoDevice = device;
                    }
                });

                if (lastAudioDevice) {
                    if (DetectRTC.browser.name === 'Firefox') {
                        if (connection.mediaConstraints.audio !== true) {
                            connection.mediaConstraints.audio.deviceId = lastAudioDevice.id;
                        } else {
                            connection.mediaConstraints.audio = {
                                deviceId: lastAudioDevice.id
                            }
                        }
                        return;
                    }

                    if (connection.mediaConstraints.audio == true) {
                        connection.mediaConstraints.audio = {
                            mandatory: {},
                            optional: []
                        }
                    }

                    if (!connection.mediaConstraints.audio.optional) {
                        connection.mediaConstraints.audio.optional = [];
                    }

                    var optional = [{
                        sourceId: lastAudioDevice.id
                    }];

                    connection.mediaConstraints.audio.optional = optional.concat(connection.mediaConstraints.audio.optional);
                }

                if (lastVideoDevice) {
                    if (DetectRTC.browser.name === 'Firefox') {
                        if (connection.mediaConstraints.video !== true) {
                            connection.mediaConstraints.video.deviceId = lastVideoDevice.id;
                        } else {
                            connection.mediaConstraints.video = {
                                deviceId: lastVideoDevice.id
                            }
                        }
                        return;
                    }

                    if (connection.mediaConstraints.video == true) {
                        connection.mediaConstraints.video = {
                            mandatory: {},
                            optional: []
                        }
                    }

                    if (!connection.mediaConstraints.video.optional) {
                        connection.mediaConstraints.video.optional = [];
                    }

                    var optional = [{
                        sourceId: lastVideoDevice.id
                    }];

                    connection.mediaConstraints.video.optional = optional.concat(connection.mediaConstraints.video.optional);
                }
            });
        }

        connection.sdpConstraints = {
            mandatory: {
                OfferToReceiveAudio: true,
                OfferToReceiveVideo: true
            },
            optional: [{
                VoiceActivityDetection: false
            }]
        };

        connection.rtcpMuxPolicy = 'require'; // "require" or "negotiate"
        connection.iceTransportPolicy = null; // "relay" or "all"
        connection.optionalArgument = {
            optional: [{
                DtlsSrtpKeyAgreement: true
            }, {
                googImprovedWifiBwe: true
            }, {
                googScreencastMinBitrate: 300
            }, {
                googIPv6: true
            }, {
                googDscp: true
            }, {
                googCpuUnderuseThreshold: 55
            }, {
                googCpuOveruseThreshold: 85
            }, {
                googSuspendBelowMinBitrate: true
            }, {
                googCpuOveruseDetection: true
            }],
            mandatory: {}
        };

        connection.iceServers = IceServersHandler.getIceServers(connection);

        connection.candidates = {
            host: true,
            stun: true,
            turn: true
        };

        connection.iceProtocols = {
            tcp: true,
            udp: true
        };

        // EVENTs
        connection.onopen = function(event) {
            console.info('나와 ', event.userid + '사이의 데이터 커넥션이 열렸습니다');
        };

        connection.onclose = function(event) {
            console.warn('나와', event.userid + '사이의 데이터 커넥션이 닫혔습니다');
        };

        connection.onerror = function(error) {
            console.error(error.userid, 'data-error', error);
        };

        connection.onmessage = function(event) {
            console.debug('data-message', event.userid, event.data);
        };

        connection.send = function(data, remoteUserId) {
            connection.peers.send(data, remoteUserId);
        };

        connection.close = connection.disconnect = connection.leave = function() {
            beforeUnload(false, true);
        };

        connection.closeEntireSession = function(callback) {
            callback = callback || function() {};
            connection.socket.emit('close-entire-session', function looper() {
                if (connection.getAllParticipants().length) {
                    setTimeout(looper, 100);
                    return;
                }

                connection.onEntireSessionClosed({
                    sessionid: connection.sessionid,
                    userid: connection.userid,
                    extra: connection.extra
                });

                connection.changeUserId(null, function() {
                    connection.close();
                    callback();
                });
            });
        };

        connection.onEntireSessionClosed = function(event) {
            console.info('모든 세션이 닫혔습니다: ', event.sessionid, event.extra);
        };

        connection.onstream = function(e) {
            var parentNode = connection.videosContainer;
            parentNode.insertBefore(e.mediaElement, parentNode.firstChild);
            var played = e.mediaElement.play();

            if (typeof played !== 'undefined') {
                played.catch(function() { /*** iOS 11 doesn't allow automatic play and rejects ***/ }).then(function() {
                    setTimeout(function() {
                        e.mediaElement.play();
                    }, 2000);
                });
                return;
            }

            setTimeout(function() {
                e.mediaElement.play();
            }, 2000);
        };

        connection.onstreamended = function(e) {
            if (!e.mediaElement) {
                e.mediaElement = document.getElementById(e.streamid);
            }

            if (!e.mediaElement || !e.mediaElement.parentNode) {
                return;
            }

            e.mediaElement.parentNode.removeChild(e.mediaElement);
        };

        connection.direction = 'many-to-many';

        connection.removeStream = function(streamid, remoteUserId) {
            var stream;
            connection.attachStreams.forEach(function(localStream) {
                if (localStream.id === streamid) {
                    stream = localStream;
                }
            });

            if (!stream) {
                console.warn('No such stream exist.', streamid);
                return;
            }

            connection.peers.getAllParticipants().forEach(function(participant) {
                if (remoteUserId && participant !== remoteUserId) {
                    return;
                }

                var user = connection.peers[participant];
                try {
                    user.peer.removeStream(stream);
                } catch (e) {}
            });

            connection.renegotiate();
        };

        connection.addStream = function(session, remoteUserId) {
            if (!!session.getAudioTracks) {
                if (connection.attachStreams.indexOf(session) === -1) {
                    if (!session.streamid) {
                        session.streamid = session.id;
                    }

                    connection.attachStreams.push(session);
                }
                connection.renegotiate(remoteUserId);
                return;
            }

            if (isData(session)) {
                connection.renegotiate(remoteUserId);
                return;
            }

            if (session.audio || session.video || session.screen) {
                if (session.screen) {
                    connection.getScreenConstraints(function(error, screen_constraints) {
                        if (error) {
                            if (error === 'PermissionDeniedError') {
                                if (session.streamCallback) {
                                    session.streamCallback(null);
                                }
                                console.error('상대 유저가 그의 스크린을 공유하는 것을 거절했습니다');
                                return;
                            }
                            return alert(error);
                        }

                        connection.invokeGetUserMedia({
                            audio: isAudioPlusTab(connection) ? getAudioScreenConstraints(screen_constraints) : false,
                            video: screen_constraints,
                            isScreen: true
                        }, (session.audio || session.video) && !isAudioPlusTab(connection) ? connection.invokeGetUserMedia(null, gumCallback) : gumCallback);
                    });
                } else if (session.audio || session.video) {
                    connection.invokeGetUserMedia(null, gumCallback);
                }
            }

            function gumCallback(stream) {
                if (session.streamCallback) {
                    session.streamCallback(stream);
                }

                connection.renegotiate(remoteUserId);
            }
        };

        connection.invokeGetUserMedia = function(localMediaConstraints, callback, session) {
            if (!session) {
                session = connection.session;
            }

            if (!localMediaConstraints) {
                localMediaConstraints = connection.mediaConstraints;
            }

            getUserMediaHandler({
                onGettingLocalMedia: function(stream) {
                    var videoConstraints = localMediaConstraints.video;
                    if (videoConstraints) {
                        if (videoConstraints.mediaSource || videoConstraints.mozMediaSource) {
                            stream.isScreen = true;
                        } else if (videoConstraints.mandatory && videoConstraints.mandatory.chromeMediaSource) {
                            stream.isScreen = true;
                        }
                    }

                    if (!stream.isScreen) {
                        stream.isVideo = stream.getVideoTracks().length;
                        stream.isAudio = !stream.isVideo && stream.getAudioTracks().length;
                    }

                    mPeer.onGettingLocalMedia(stream);

                    if (callback) {
                        callback(stream);
                    }
                },
                onLocalMediaError: function(error, constraints) {
                    mPeer.onLocalMediaError(error, constraints);
                },
                localMediaConstraints: localMediaConstraints || {
                    audio: session.audio ? localMediaConstraints.audio : false,
                    video: session.video ? localMediaConstraints.video : false
                }
            });
        };

        function applyConstraints(stream, mediaConstraints) {
            if (!stream) {
                console.error('applyConstraints할 스트림이 없습니다');
                return;
            }

            if (mediaConstraints.audio) {
                stream.getAudioTracks().forEach(function(track) {
                    track.applyConstraints(mediaConstraints.audio);
                });
            }

            if (mediaConstraints.video) {
                stream.getVideoTracks().forEach(function(track) {
                    track.applyConstraints(mediaConstraints.video);
                });
            }
        }

        connection.applyConstraints = function(mediaConstraints, streamid) {
            if (!MediaStreamTrack || !MediaStreamTrack.prototype.applyConstraints) {
                alert('track.applyConstraints is NOT supported in your browser.');
                return;
            }

            if (streamid) {
                var stream;
                if (connection.streamEvents[streamid]) {
                    stream = connection.streamEvents[streamid].stream;
                }
                applyConstraints(stream, mediaConstraints);
                return;
            }

            connection.attachStreams.forEach(function(stream) {
                applyConstraints(stream, mediaConstraints);
            });
        };

        function replaceTrack(track, remoteUserId, isVideoTrack) {
            if (remoteUserId) {
                mPeer.replaceTrack(track, remoteUserId, isVideoTrack);
                return;
            }

            connection.peers.getAllParticipants().forEach(function(participant) {
                mPeer.replaceTrack(track, participant, isVideoTrack);
            });
        }

        connection.replaceTrack = function(session, remoteUserId, isVideoTrack) {
            session = session || {};

            if (!RTCPeerConnection.prototype.getSenders) {
                connection.addStream(session);
                return;
            }

            if (session instanceof MediaStreamTrack) {
                replaceTrack(session, remoteUserId, isVideoTrack);
                return;
            }

            if (session instanceof MediaStream) {
                if (session.getVideoTracks().length) {
                    replaceTrack(session.getVideoTracks()[0], remoteUserId, true);
                }

                if (session.getAudioTracks().length) {
                    replaceTrack(session.getAudioTracks()[0], remoteUserId, false);
                }
                return;
            }

            if (isData(session)) {
                throw 'connection.replaceTrack requires audio and/or video and/or screen.';
                return;
            }

            if (session.audio || session.video || session.screen) {
                if (session.screen) {
                    connection.getScreenConstraints(function(error, screen_constraints) {
                        if (error) {
                            return alert(error);
                        }

                        connection.invokeGetUserMedia({
                            audio: isAudioPlusTab(connection) ? getAudioScreenConstraints(screen_constraints) : false,
                            video: screen_constraints,
                            isScreen: true
                        }, (session.audio || session.video) && !isAudioPlusTab(connection) ? connection.invokeGetUserMedia(null, gumCallback) : gumCallback);
                    });
                } else if (session.audio || session.video) {
                    connection.invokeGetUserMedia(null, gumCallback);
                }
            }

            function gumCallback(stream) {
                connection.replaceTrack(stream, remoteUserId, isVideoTrack || session.video || session.screen);
            }
        };

        connection.resetTrack = function(remoteUsersIds, isVideoTrack) {
            if (!remoteUsersIds) {
                remoteUsersIds = connection.getAllParticipants();
            }

            if (typeof remoteUsersIds == 'string') {
                remoteUsersIds = [remoteUsersIds];
            }

            remoteUsersIds.forEach(function(participant) {
                var peer = connection.peers[participant].peer;

                if ((typeof isVideoTrack === 'undefined' || isVideoTrack === true) && peer.lastVideoTrack) {
                    connection.replaceTrack(peer.lastVideoTrack, participant, true);
                }

                if ((typeof isVideoTrack === 'undefined' || isVideoTrack === false) && peer.lastAudioTrack) {
                    connection.replaceTrack(peer.lastAudioTrack, participant, false);
                }
            });
        };

        connection.renegotiate = function(remoteUserId) {
            if (remoteUserId) {
                mPeer.renegotiatePeer(remoteUserId);
                return;
            }

            connection.peers.getAllParticipants().forEach(function(participant) {
                mPeer.renegotiatePeer(participant);
            });
        };

        connection.setStreamEndHandler = function(stream, isRemote) {
            if (!stream || !stream.addEventListener) return;

            isRemote = !!isRemote;

            if (stream.alreadySetEndHandler) {
                return;
            }
            stream.alreadySetEndHandler = true;

            var streamEndedEvent = 'ended';

            if ('oninactive' in stream) {
                streamEndedEvent = 'inactive';
            }

            stream.addEventListener(streamEndedEvent, function() {
                if (stream.idInstance) {
                    currentUserMediaRequest.remove(stream.idInstance);
                }

                if (!isRemote) {
                    // reset attachStreams
                    var streams = [];
                    connection.attachStreams.forEach(function(s) {
                        if (s.id != stream.id) {
                            streams.push(s);
                        }
                    });
                    connection.attachStreams = streams;
                }

                // connection.renegotiate();

                var streamEvent = connection.streamEvents[stream.streamid];
                if (!streamEvent) {
                    streamEvent = {
                        stream: stream,
                        streamid: stream.streamid,
                        type: isRemote ? 'remote' : 'local',
                        userid: connection.userid,
                        extra: connection.extra,
                        mediaElement: connection.streamEvents[stream.streamid] ? connection.streamEvents[stream.streamid].mediaElement : null
                    };
                }

                if (isRemote && connection.peers[streamEvent.userid]) {
                    // reset remote "streams"
                    var peer = connection.peers[streamEvent.userid].peer;
                    var streams = [];
                    peer.getRemoteStreams().forEach(function(s) {
                        if (s.id != stream.id) {
                            streams.push(s);
                        }
                    });
                    connection.peers[streamEvent.userid].streams = streams;
                }

                if (streamEvent.userid === connection.userid && streamEvent.type === 'remote') {
                    return;
                }

                if (connection.peersBackup[streamEvent.userid]) {
                    streamEvent.extra = connection.peersBackup[streamEvent.userid].extra;
                }

                connection.onstreamended(streamEvent);

                delete connection.streamEvents[stream.streamid];
            }, false);
        };

        connection.onMediaError = function(error, constraints) {
            console.error(error, constraints);
        };

        connection.addNewBroadcaster = function(broadcasterId, userPreferences) {
            if (connection.socket.isIO) {
                return;
            }

            if (connection.broadcasters.length) {
                setTimeout(function() {
                    mPeer.connectNewParticipantWithAllBroadcasters(broadcasterId, userPreferences, connection.broadcasters.join('|-,-|'));
                }, 10 * 1000);
            }

            if (!connection.session.oneway && !connection.session.broadcast && connection.direction === 'many-to-many' && connection.broadcasters.indexOf(broadcasterId) === -1) {
                connection.broadcasters.push(broadcasterId);
                keepNextBroadcasterOnServer();
            }
        };

        connection.autoCloseEntireSession = false;

        function keepNextBroadcasterOnServer() {
            if (!connection.isInitiator) return;

            if (connection.session.oneway || connection.session.broadcast || connection.direction !== 'many-to-many') {
                return;
            }

            var firstBroadcaster = connection.broadcasters[0];
            var otherBroadcasters = [];
            connection.broadcasters.forEach(function(broadcaster) {
                if (broadcaster !== firstBroadcaster) {
                    otherBroadcasters.push(broadcaster);
                }
            });

            if (connection.autoCloseEntireSession) return;
            connection.shiftModerationControl(firstBroadcaster, otherBroadcasters, true);
        };

        connection.filesContainer = connection.videosContainer = document.body || document.documentElement;
        connection.isInitiator = false;

        connection.shareFile = mPeer.shareFile;
        if (typeof FileProgressBarHandler !== 'undefined') {
            FileProgressBarHandler.handle(connection);
        }

        if (typeof TranslationHandler !== 'undefined') {
            TranslationHandler.handle(connection);
        }

        connection.token = getRandomString;

        connection.onNewParticipant = function(participantId, userPreferences) {
            connection.acceptParticipationRequest(participantId, userPreferences);
        };

        connection.acceptParticipationRequest = function(participantId, userPreferences) {
            if (userPreferences.successCallback) {
                userPreferences.successCallback();
                delete userPreferences.successCallback;
            }

            mPeer.createNewPeer(participantId, userPreferences);
        };

        connection.onShiftedModerationControl = function(sender, existingBroadcasters) {
            connection.acceptModerationControl(sender, existingBroadcasters);
        };

        connection.acceptModerationControl = function(sender, existingBroadcasters) {
            connection.isInitiator = true; // NEW initiator!

            connection.broadcasters = existingBroadcasters;
            connection.peers.getAllParticipants().forEach(function(participant) {
                mPeer.onNegotiationNeeded({
                    changedUUID: sender,
                    oldUUID: connection.userid,
                    newUUID: sender
                }, participant);
            });
            connection.userid = sender;
            connection.changeUserId(connection.userid);
        };

        connection.shiftModerationControl = function(remoteUserId, existingBroadcasters, firedOnLeave) {
            mPeer.onNegotiationNeeded({
                shiftedModerationControl: true,
                broadcasters: existingBroadcasters,
                firedOnLeave: !!firedOnLeave
            }, remoteUserId);
        };

        if (typeof StreamsHandler !== 'undefined') {
            connection.StreamsHandler = StreamsHandler;
        }

        connection.onleave = function(userid) {};

        connection.invokeSelectFileDialog = function(callback) {
            var selector = new FileSelector();
            selector.accept = '*.*';
            selector.selectSingleFile(callback);
        };

        connection.getPublicModerators = function(userIdStartsWith, callback) {
            if (typeof userIdStartsWith === 'function') {
                callback = userIdStartsWith;
            }

            connectSocket(function() {
                connection.socket.emit(
                    'get-public-moderators',
                    typeof userIdStartsWith === 'string' ? userIdStartsWith : '',
                    callback
                );
            });
        };

        connection.onmute = function(e) {
            if (!e || !e.mediaElement) {
                return;
            }

            if (e.muteType === 'both' || e.muteType === 'video') {
                e.mediaElement.src = null;
                var paused = e.mediaElement.pause();
                if (typeof paused !== 'undefined') {
                    paused.then(function() {
                        e.mediaElement.poster = e.snapshot || 'https://cdn.webrtc-experiment.com/images/muted.png';
                    });
                } else {
                    e.mediaElement.poster = e.snapshot || 'https://cdn.webrtc-experiment.com/images/muted.png';
                }
            } else if (e.muteType === 'audio') {
                e.mediaElement.muted = true;
            }
        };

        connection.onunmute = function(e) {
            if (!e || !e.mediaElement || !e.stream) {
                return;
            }

            if (e.unmuteType === 'both' || e.unmuteType === 'video') {
                e.mediaElement.poster = null;
                e.mediaElement.srcObject = e.stream;
                e.mediaElement.play();
            } else if (e.unmuteType === 'audio') {
                e.mediaElement.muted = false;
            }
        };

        connection.onExtraDataUpdated = function(event) {
            event.status = 'online';
            connection.onUserStatusChanged(event, true);
        };

        connection.onJoinWithPassword = function(remoteUserId) {
            console.warn(remoteUserId, 'is password protected. Please join with password.');
        };

        connection.onInvalidPassword = function(remoteUserId, oldPassword) {
            console.warn(remoteUserId, 'is password protected. Please join with valid password. Your old password', oldPassword, 'is wrong.');
        };

        connection.onPasswordMaxTriesOver = function(remoteUserId) {
            console.warn(remoteUserId, 'is password protected. Your max password tries exceeded the limit.');
        };

        connection.getAllParticipants = function(sender) {
            return connection.peers.getAllParticipants(sender);
        };

        if (typeof StreamsHandler !== 'undefined') {
            StreamsHandler.onSyncNeeded = function(streamid, action, type) {
                connection.peers.getAllParticipants().forEach(function(participant) {
                    mPeer.onNegotiationNeeded({
                        streamid: streamid,
                        action: action,
                        streamSyncNeeded: true,
                        type: type || 'both'
                    }, participant);
                });
            };
        }

        connection.connectSocket = function(callback) {
            connectSocket(callback);
        };

        connection.closeSocket = function() {
            try {
                io.sockets = {};
            } catch (e) {};

            if (!connection.socket) return;

            if (typeof connection.socket.disconnect === 'function') {
                connection.socket.disconnect();
            }

            if (typeof connection.socket.resetProps === 'function') {
                connection.socket.resetProps();
            }

            connection.socket = null;
        };

        connection.getSocket = function(callback) {
            if (!connection.socket) {
                connectSocket(callback);
            } else if (callback) {
                callback(connection.socket);
            }

            return connection.socket;
        };

        connection.getRemoteStreams = mPeer.getRemoteStreams;

        var skipStreams = ['selectFirst', 'selectAll', 'forEach'];

        connection.streamEvents = {
            selectFirst: function(options) {
                if (!options) {
                    // in normal conferencing, it will always be "local-stream"
                    var firstStream;
                    for (var str in connection.streamEvents) {
                        if (skipStreams.indexOf(str) === -1 && !firstStream) {
                            firstStream = connection.streamEvents[str];
                            continue;
                        }
                    }
                    return firstStream;
                }
            },
            selectAll: function() {}
        };

        connection.socketURL = '/'; // generated via config.json
        connection.socketMessageEvent = 'RTCMultiConnection-Message'; // generated via config.json
        connection.DetectRTC = DetectRTC;

        connection.getNumberOfBroadcastViewers = function(broadcastId, callback) {
            if (!connection.socket || !broadcastId || !callback) return;

            connection.socket.emit('get-number-of-users-in-specific-broadcast', broadcastId, callback);
        };

        connection.onNumberOfBroadcastViewersUpdated = function(event) {
            if (!connection.isInitiator) return;
            console.info('Number of broadcast (', event.broadcastId, ') viewers', event.numberOfBroadcastViewers);
        };

        connection.onUserStatusChanged = function(event, dontWriteLogs) {
            if (!dontWriteLogs) {
                console.info(event.userid, event.status);
            }
        };

        connection.getUserMediaHandler = getUserMediaHandler;
        connection.multiPeersHandler = mPeer;

        // default value is 15k because Firefox's receiving limit is 16k!
        // however 64k works chrome-to-chrome
        connection.chunkSize = 65 * 1000;

        connection.maxParticipantsAllowed = 1000;

        // eject or leave single user
        connection.disconnectWith = mPeer.disconnectWith;

        connection.checkPresence = function(remoteUserId, callback) {
            if (!connection.socket) {
                connection.connectSocket(function() {
                    connection.checkPresence(remoteUserId, callback);
                });
                return;
            }
            connection.socket.emit('check-presence', (remoteUserId || connection.sessionid) + '', callback);
        };

        connection.onReadyForOffer = function(remoteUserId, userPreferences) {
            connection.multiPeersHandler.createNewPeer(remoteUserId, userPreferences);
        };

        connection.setUserPreferences = function(userPreferences) {
            if (connection.dontAttachStream) {
                userPreferences.dontAttachLocalStream = true;
            }

            if (connection.dontGetRemoteStream) {
                userPreferences.dontGetRemoteStream = true;
            }

            return userPreferences;
        };

        connection.updateExtraData = function() {
            connection.socket.emit('extra-data-updated', connection.extra);
        };

        connection.enableScalableBroadcast = false;
        connection.maxRelayLimitPerUser = 3; // each broadcast should serve only 3 users

        connection.dontCaptureUserMedia = false;
        connection.dontAttachStream = false;
        connection.dontGetRemoteStream = false;

        connection.onReConnecting = function(event) {
            console.info(event.userid, '와 다시 연결합니다...');
        };

        connection.beforeAddingStream = function(stream) {
            return stream;
        };

        connection.beforeRemovingStream = function(stream) {
            return stream;
        };

        if (typeof isChromeExtensionAvailable !== 'undefined') {
            connection.checkIfChromeExtensionAvailable = isChromeExtensionAvailable;
        }

        if (typeof isFirefoxExtensionAvailable !== 'undefined') {
            connection.checkIfChromeExtensionAvailable = isFirefoxExtensionAvailable;
        }

        if (typeof getChromeExtensionStatus !== 'undefined') {
            connection.getChromeExtensionStatus = getChromeExtensionStatus;
        }

        connection.getScreenConstraints = function(callback, audioPlusTab) {
            if (isAudioPlusTab(connection, audioPlusTab)) {
                audioPlusTab = true;
            }

            getScreenConstraints(function(error, screen_constraints) {
                if (!error) {
                    screen_constraints = connection.modifyScreenConstraints(screen_constraints);
                    callback(error, screen_constraints);
                }
            }, audioPlusTab);
        };

        connection.modifyScreenConstraints = function(screen_constraints) {
            return screen_constraints;
        };

        connection.onPeerStateChanged = function(state) {
            if (state.iceConnectionState.search(/closed|failed/gi) !== -1) {
                console.error(state.userid, '와 나 사이의 피어 커넥션이 닫혔습니다', state.extra, '상태: ', state.iceConnectionState);
            }
        };

        connection.isOnline = true;

        listenEventHandler('online', function() {
            connection.isOnline = true;
        });

        listenEventHandler('offline', function() {
            connection.isOnline = false;
        });

        connection.isLowBandwidth = false;
        if (navigator && navigator.connection && navigator.connection.type) {
            connection.isLowBandwidth = navigator.connection.type.toString().toLowerCase().search(/wifi|cell/g) !== -1;
            if (connection.isLowBandwidth) {
                connection.bandwidth = {
                    audio: false,
                    video: false,
                    screen: false
                };

                if (connection.mediaConstraints.audio && connection.mediaConstraints.audio.optional && connection.mediaConstraints.audio.optional.length) {
                    var newArray = [];
                    connection.mediaConstraints.audio.optional.forEach(function(opt) {
                        if (typeof opt.bandwidth === 'undefined') {
                            newArray.push(opt);
                        }
                    });
                    connection.mediaConstraints.audio.optional = newArray;
                }

                if (connection.mediaConstraints.video && connection.mediaConstraints.video.optional && connection.mediaConstraints.video.optional.length) {
                    var newArray = [];
                    connection.mediaConstraints.video.optional.forEach(function(opt) {
                        if (typeof opt.bandwidth === 'undefined') {
                            newArray.push(opt);
                        }
                    });
                    connection.mediaConstraints.video.optional = newArray;
                }
            }
        }

        connection.getExtraData = function(remoteUserId) {
            if (!remoteUserId) throw 'remoteUserId is required.';
            if (!connection.peers[remoteUserId]) return {};
            return connection.peers[remoteUserId].extra;
        };

        if (!!forceOptions.autoOpenOrJoin) {
            connection.openOrJoin(connection.sessionid);
        }

        connection.onUserIdAlreadyTaken = function(useridAlreadyTaken, yourNewUserId) {
            console.warn('userid가 이미 존재합니다', useridAlreadyTaken, ' 새로운 userid: ', yourNewUserId);

            connection.join(useridAlreadyTaken);
        };

        connection.onRoomFull = function(roomid) {
            console.warn(roomid, '이 꽉찼습니다');
        };

        connection.trickleIce = true;
        connection.version = '3.4.4';

        connection.onSettingLocalDescription = function(event) {
            console.info(event.userid, '리모트 유저를 위해 Local Description을 설정합니다');
        };

        connection.oneRoomAlreadyExist = function(roomid) {
            console.info('"방 ', roomid, '이 이미 존재하니 재입장하세요" 라고 서버가 말합니다');
            connection.join(roomid);
        };

        connection.resetScreen = function() {
            sourceId = null;
            if (DetectRTC && DetectRTC.screen) {
                delete DetectRTC.screen.sourceId;
            }

            currentUserMediaRequest = {
                streams: [],
                mutex: false,
                queueRequests: []
            };
        };
    })(this);

};
