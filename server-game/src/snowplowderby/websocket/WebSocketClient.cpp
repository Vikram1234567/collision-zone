#include "WebSocketClient.hpp"

#include <rapidjson/document.h>
#include <rapidjson/rapidjson.h>
#include <string>

#include "util/log.hpp"
#include "snowplowderby/game/Request.hpp"


using namespace websocketpp;
using namespace snowplowderby::websocket;
using namespace snowplowderby::game::request;
using namespace snowplowderby::client;


util::Logger WebSocketClient::logger = util::get_logger("WSP-WebSocketClient");

WebSocketClient::WebSocketClient(ArenaPtr arena, WebSocketClientSource* parent, std::shared_ptr<WSPPConnection> connection) 
    : Client(arena), connection(connection), parent(parent) {
    set_state(ClientState::SPECTATING);
}

WebSocketClient::~WebSocketClient() {
    
}

void WebSocketClient::read_transition_request(const char* string) {
    LOG_DEBUG(logger) << "Parsing transition request: " << string;
    rapidjson::Document doc;
    doc.Parse(string);

    std::stringstream ss;
    char error[] = {0x01, 1, 0, 0};
    ss.write(error, 4);
    if (!doc.IsObject()) {
        LOG_ERROR(logger) << "Received malformed transition request: it's not an object! " << string;
        send_binary_reliable(ss.str());
        return;
    }
    if (!doc.HasMember("username") || !doc.HasMember("player_class")) {
        LOG_ERROR(logger) << "Received malformed transition request: missing fields! " << string;
        send_binary_reliable(ss.str());
        return;
    }
    const rapidjson::Value& name_field = doc["username"];
    if (!name_field.IsString()) {
        LOG_ERROR(logger) << "Received non-object transition request: \"name_field\" is not a string!" << string;
        send_binary_reliable(ss.str());
        return;
    }
    const rapidjson::Value& player_class_field = doc["player_class"];
    if (!player_class_field.IsInt()) {
        LOG_ERROR(logger) << "Received non-object transition request: \"player_class\" is not a integer!" << string;
        send_binary_reliable(ss.str());
        return;
    }

    std::string name(name_field.GetString());
    char player_class = player_class_field.GetInt();
    LOG_INFO(logger) << "Requesting to create player with name " << name;
    arena->submit_request(new CreatePlayerRequest(
        player_class, name, [this](PlayerPtr player){
            on_player_created(player);
        }
    ));
    LOG_INFO(logger) << "Player creation request successfully submitted for " << name;
}

void WebSocketClient::send_binary_unreliable(std::string data) {
    connection->send("u" + data, frame::opcode::binary);
}

void WebSocketClient::send_binary_reliable(std::string data) {
    connection->send("r" + data, frame::opcode::binary);
}

void WebSocketClient::on_player_created(PlayerPtr player) {
    unsigned short id = player->get_id();
    LOG_INFO(logger) << "Received player " << id;
    this->player = player;
    set_state(ClientState::PLAYING);

    std::stringstream ss;
    char msg[] = {0x01, 0, (char)id, (char)(id >> 8)};
    std::string data(msg);
    ss.write(msg, 4);

    send_binary_reliable(ss.str());
}

void WebSocketClient::set_state(ClientState state) {
    Client::set_state(state);
    switch (state) {
        case SPECTATING:
            connection->set_message_handler([this](auto h, auto m){ 
                handle_message_spectating(h, m); 
            });
            connection->set_close_handler(nullptr);
            break;
        case PLAYING:
            connection->set_message_handler([this](auto h, auto m) {
                handle_message_playing(h, m);
            });
            connection->set_close_handler([this](auto h) {
                handle_close_playing(h);
            });
            break;
        default:
            break;
    }
}

void WebSocketClient::handle_message_spectating(connection_hdl handle, WSPPConnection::message_ptr message) {
    auto handle_raw = handle.lock().get();
    auto payload = message->get_payload();
    LOG_TRACE(logger) << "Received message from " << handle_raw << ": " << payload;

    std::stringstream stream(payload);
    char type;
    stream >> type;

    if (type == 'r') {
        char cmd_type;
        stream >> cmd_type;
        if (cmd_type == 't') {  // transition request
            read_transition_request(payload.c_str() + 2);
            return;
        }
    }
}

void WebSocketClient::handle_message_playing(connection_hdl handle, WSPPConnection::message_ptr message) {
    auto handle_raw = handle.lock().get();
    auto payload = message->get_payload();
    LOG_TRACE(logger) << "Received message from " << handle_raw << ": " << payload;

    std::stringstream stream(payload);
    char type;
    char cmd_type;
    stream >> type;

    if (type == 'r') {  // reliable
        stream >> cmd_type;
        switch (cmd_type) {
            case 's':  // Chat
            break;
        }
    } else {  // unreliable
        float dx;
        float dy;
        stream.read(reinterpret_cast<char*>(&dx), 4);
        stream.read(reinterpret_cast<char*>(&dy), 4);

        LOG_TRACE(logger) << "Received client input " << dx << ", " << dy;
    }
}

void WebSocketClient::handle_close_playing(connection_hdl handle) {
    short id = player->get_id();
    LOG_DEBUG(logger) << "Player " << id << " disconnected";

    arena->submit_request(new DestroyPlayerRequest(player, [id] {
        LOG_DEBUG(logger) << "Player " << id << " successfully destroyed";
    }));
}
