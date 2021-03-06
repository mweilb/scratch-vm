/**
 * @fileoverview
 * Partial implementation of an SB2 JSON importer.
 * Parses provided JSON and then generates all needed
 * scratch-vm runtime structures.
 */

var Sprite = require('../sprites/sprite');
var Blocks = require('../engine/blocks');

var uid = require('../util/uid');
var specMap = require('./sb2specmap');

/**
 * Top-level handler. Parse provided JSON,
 * and process the top-level object (the stage object).
 * @param {!string} json SB2-format JSON to load.
 * @param {!Runtime} runtime Runtime object to load all structures into.
 */
function sb2import (json, runtime) {
    parseScratchObject(
        JSON.parse(json),
        runtime
    );
}

/**
 * Parse a single "Scratch object" and create all its in-memory VM objects.
 * @param {!Object} object From-JSON "Scratch object:" sprite, stage, watcher.
 * @param {!Runtime} runtime Runtime object to load all structures into.
 */
function parseScratchObject (object, runtime) {
    if (!object.hasOwnProperty('objName')) {
        // Watcher/monitor - skip this object until those are implemented in VM.
        // @todo
        return;
    }
    // Blocks container for this object.
    var blocks = new Blocks();
    // @todo: For now, load all Scratch objects (stage/sprites) as a Sprite.
    var sprite = new Sprite(blocks);
    // Sprite/stage name from JSON.
    if (object.hasOwnProperty('objName')) {
        sprite.name = object.objName;
    }
    // Costumes from JSON.
    if (object.hasOwnProperty('costumes')) {
        for (var i = 0; i < object.costumes.length; i++) {
            var costume = object.costumes[i];
            // @todo: Make sure all the relevant metadata is being pulled out.
            sprite.costumes.push({
                skin: costume.baseLayerMD5,
                name: costume.costumeName,
                bitmapResolution: costume.bitmapResolution,
                rotationCenterX: costume.rotationCenterX,
                rotationCenterY: costume.rotationCenterY
            });
        }
    }
    // If included, parse any and all scripts/blocks on the object.
    if (object.hasOwnProperty('scripts')) {
        parseScripts(object.scripts, blocks);
    }
    // Create the first clone, and load its run-state from JSON.
    var target = sprite.createClone();
    // Add it to the runtime's list of targets.
    runtime.targets.push(target);
    if (object.scratchX) {
        target.x = object.scratchX;
    }
    if (object.scratchY) {
        target.y = object.scratchY;
    }
    if (object.direction) {
        target.direction = object.direction;
    }
    if (object.scale) {
        // SB2 stores as 1.0 = 100%; we use % in the VM.
        target.size = object.scale * 100;
    }
    if (object.visible) {
        target.visible = object.visible;
    }
    if (object.currentCostumeIndex) {
        target.currentCostume = object.currentCostumeIndex;
    }
    // The stage will have child objects; recursively process them.
    if (object.children) {
        for (var j = 0; j < object.children.length; j++) {
            parseScratchObject(object.children[j], runtime);
        }
    }
}

/**
 * Parse a Scratch object's scripts into VM blocks.
 * This should only handle top-level scripts that include X, Y coordinates.
 * @param {!Object} scripts Scripts object from SB2 JSON.
 * @param {!Blocks} blocks Blocks object to load parsed blocks into.
 */
function parseScripts (scripts, blocks) {
    for (var i = 0; i < scripts.length; i++) {
        var script = scripts[i];
        var scriptX = script[0];
        var scriptY = script[1];
        var blockList = script[2];
        var parsedBlockList = parseBlockList(blockList);
        if (parsedBlockList[0]) {
            // Adjust script coordinates to account for
            // larger block size in scratch-blocks.
            // @todo: Determine more precisely the right formulas here.
            parsedBlockList[0].x = scriptX * 1.1;
            parsedBlockList[0].y = scriptY * 1.1;
            parsedBlockList[0].topLevel = true;
        }
        // Flatten children and create add the blocks.
        var convertedBlocks = flatten(parsedBlockList);
        for (var j = 0; j < convertedBlocks.length; j++) {
            blocks.createBlock(convertedBlocks[j]);
        }
    }
}

/**
 * Parse any list of blocks from SB2 JSON into a list of VM-format blocks.
 * Could be used to parse a top-level script,
 * a list of blocks in a branch (e.g., in forever),
 * or a list of blocks in an argument (e.g., move [pick random...]).
 * @param {Array.<Object>} blockList SB2 JSON-format block list.
 * @return {Array.<Object>} Scratch VM-format block list.
 */
function parseBlockList (blockList) {
    var resultingList = [];
    var previousBlock = null; // For setting next.
    for (var i = 0; i < blockList.length; i++) {
        var block = blockList[i];
        var parsedBlock = parseBlock(block);
        if (previousBlock) {
            previousBlock.next = parsedBlock.id;
        }
        previousBlock = parsedBlock;
        resultingList.push(parsedBlock);
    }
    return resultingList;
}

/**
 * Flatten a block tree into a block list.
 * Children are temporarily stored on the `block.children` property.
 * @param {Array.<Object>} blocks list generated by `parseBlockList`.
 * @return {Array.<Object>} Flattened list to be passed to `blocks.createBlock`.
 */
function flatten (blocks) {
    var finalBlocks = [];
    for (var i = 0; i < blocks.length; i++) {
        var block = blocks[i];
        finalBlocks.push(block);
        if (block.children) {
            finalBlocks = finalBlocks.concat(flatten(block.children));
        }
        delete block.children;
    }
    return finalBlocks;
}

/**
 * Parse a single SB2 JSON-formatted block and its children.
 * @param {!Object} sb2block SB2 JSON-formatted block.
 * @return {Object} Scratch VM format block.
 */
function parseBlock (sb2block) {
    // First item in block object is the old opcode (e.g., 'forward:').
    var oldOpcode = sb2block[0];
    // Convert the block using the specMap. See sb2specmap.js.
    if (!oldOpcode || !specMap[oldOpcode]) {
        console.warn('Couldn\'t find SB2 block: ', oldOpcode);
        return;
    }
    var blockMetadata = specMap[oldOpcode];
    // Block skeleton.
    var activeBlock = {
        id: uid(), // Generate a new block unique ID.
        opcode: blockMetadata.opcode, // Converted, e.g. "motion_movesteps".
        inputs: {}, // Inputs to this block and the blocks they point to.
        fields: {}, // Fields on this block and their values.
        shadow: false, // No shadow blocks in an SB2 by default.
        children: [] // Store any generated children, flattened in `flatten`.
    };
    // Look at the expected arguments in `blockMetadata.argMap.`
    // The basic problem here is to turn positional SB2 arguments into
    // non-positional named Scratch VM arguments.
    for (var i = 0; i < blockMetadata.argMap.length; i++) {
        var expectedArg = blockMetadata.argMap[i];
        var providedArg = sb2block[i + 1]; // (i = 0 is opcode)
        // Positional argument is an input.
        if (expectedArg.type == 'input') {
            // Create a new block and input metadata.
            var inputUid = uid();
            activeBlock.inputs[expectedArg.inputName] = {
                name: expectedArg.inputName,
                block: inputUid
            };
            if (typeof providedArg == 'object') {
                // Block or block list occupies the input.
                var innerBlocks;
                if (typeof providedArg[0] == 'object') {
                    // Block list occupies the input.
                    innerBlocks = parseBlockList(providedArg);
                } else {
                    // Single block occupies the input.
                    innerBlocks = [parseBlock(providedArg)];
                }
                activeBlock.inputs[expectedArg.inputName] = {
                    name: expectedArg.inputName,
                    block: innerBlocks[0].id
                };
                activeBlock.children = (
                    activeBlock.children.concat(innerBlocks)
                );
            } else if (expectedArg.inputOp) {
                // Unoccupied input. Generate a shadow block to occupy it.
                var fieldName = expectedArg.inputName;
                if (expectedArg.inputOp == 'math_number') {
                    fieldName = 'NUM';
                } else if (expectedArg.inputOp == 'text') {
                    fieldName = 'TEXT';
                } else if (expectedArg.inputOp == 'colour_picker') {
                    fieldName = 'COLOR';
                }
                var fields = {};
                fields[fieldName] = {
                    name: fieldName,
                    value: providedArg
                };
                activeBlock.children.push({
                    id: inputUid,
                    opcode: expectedArg.inputOp,
                    inputs: {},
                    fields: fields,
                    next: null,
                    topLevel: false,
                    shadow: true
                });
            }
        } else if (expectedArg.type == 'field') {
            // Add as a field on this block.
            activeBlock.fields[expectedArg.fieldName] = {
                name: expectedArg.fieldName,
                value: providedArg
            };
        }
    }
    return activeBlock;
}

module.exports = sb2import;
